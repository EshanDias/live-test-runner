'use strict';
/**
 * jestCoverage.js — Jest's own coverage, per test file: what `jest --coverage`
 * reports, but kept per test file so the extension can replace a test file's
 * coverage when it runs again. Everything goes through the project's own Jest
 * libraries (@jest/reporters and its dependencies), converted exactly as
 * Jest's CoverageReporter converts them:
 *  - coverageProvider 'babel': the test file's istanbul data
 *    (`testResult.coverage`), remapped through any input source map
 *    (istanbul-lib-source-maps, `_getCoverageResult`);
 *  - coverageProvider 'v8': the test file's `testResult.v8Coverage`, through
 *    v8-to-istanbul (`_getCoverageResult`);
 *  - files no test loads: Jest's own generateEmptyCoverage (`_addUntestedFiles`).
 *
 * Used by liveReporter.js (in Jest's process) and jestCoverageCount.js (a
 * child process). Never loaded by the extension itself.
 */

const fs = require('fs');
const path = require('path');

/** Where the project's Jest packages live (jest → jest-cli → @jest/core → @jest/reporters, @jest/transform). */
function jestPaths(rootDir) {
  const paths = [rootDir];
  const tryResolve = (id) => { try { return require.resolve(id, { paths: paths.slice() }); } catch (_) { return undefined; } };
  for (const id of ['jest/package.json', 'jest-cli/package.json', '@jest/core/package.json', '@jest/reporters/package.json', '@jest/transform/package.json']) {
    const p = tryResolve(id);
    if (p) { paths.unshift(path.dirname(p)); }
  }
  return paths;
}

const _cache = new Map();
/** A package as the project's Jest loads it. */
function fromJest(rootDir, id) {
  const key = `${rootDir}\0${id}`;
  if (!_cache.has(key)) {
    const mod = require(require.resolve(id, { paths: jestPaths(rootDir) }));
    _cache.set(key, mod);
  }
  return _cache.get(key);
}

/**
 * `testResult.v8Coverage` arrays (one per test file, or one per file no test
 * loads) → an istanbul coverage map, as Jest's `_getCoverageResult` does.
 * @param results array of `[{ codeTransformResult, result }]`
 */
async function v8ToMap(rootDir, results) {
  const v8ToIstanbul = fromJest(rootDir, 'v8-to-istanbul');
  const convert = v8ToIstanbul.default || v8ToIstanbul;
  const { mergeProcessCovs } = fromJest(rootDir, '@bcoe/v8-coverage');
  const merged = mergeProcessCovs(results.map((cov) => ({ result: cov.map((r) => r.result) })));
  const fileTransforms = new Map();
  for (const res of results) {
    for (const r of res) {
      if (r.codeTransformResult && !fileTransforms.has(r.result.url)) { fileTransforms.set(r.result.url, r.codeTransformResult); }
    }
  }
  const out = {};
  for (const res of merged.result) {
    const fileTransform = fileTransforms.get(res.url);
    let sourcemapContent;
    if (fileTransform && fileTransform.sourceMapPath && fs.existsSync(fileTransform.sourceMapPath)) {
      sourcemapContent = JSON.parse(fs.readFileSync(fileTransform.sourceMapPath, 'utf8'));
    }
    const converter = convert(
      res.url,
      (fileTransform && fileTransform.wrapperLength) || 0,
      fileTransform && sourcemapContent
        ? { originalSource: fileTransform.originalCode, source: fileTransform.code, sourceMap: { sourcemap: { file: res.url, ...sourcemapContent } } }
        : { source: fs.readFileSync(res.url, 'utf8') },
    );
    await converter.load();
    converter.applyCoverage(withoutWrapper(res.functions, fileTransform && sourcemapContent ? fileTransform.wrapperLength || 0 : 0));
    Object.assign(out, converter.toIstanbul());
    if (typeof converter.destroy === 'function') { converter.destroy(); }
  }
  return out;
}

/**
 * The script itself and Jest's module wrapper (`({"Object.<anonymous>":function(module, exports, …){`)
 * are not the file's code: their outer range starts in the wrapper. Through the
 * project transformer's source map that range maps nowhere, so Jest's own report
 * never shows it; through our transform's map (which maps more positions) it
 * would show as an extra function and branch. Their inner ranges are the
 * file's code and stay.
 */
function withoutWrapper(functions, wrapperLength) {
  if (!wrapperLength) { return functions; }
  const out = [];
  for (const fn of functions) {
    const outer = fn.ranges && fn.ranges[0];
    if (outer && outer.startOffset < wrapperLength) {
      if (fn.ranges.length > 1) { out.push({ ...fn, functionName: '', ranges: fn.ranges.slice(1) }); }
      continue;
    }
    out.push(fn);
  }
  return out;
}

/** Istanbul data (babel provider) → the coverage map Jest reports: remapped through each file's input source map. */
async function babelToMap(rootDir, coverage) {
  // Instrumented by the project's transformer itself (babel-jest): already the file's own
  // positions, nothing to remap (istanbul-lib-source-maps would only copy it).
  if (!Object.values(coverage).some((fc) => fc && (fc.inputSourceMap || (fc.data && fc.data.inputSourceMap)))) {
    const out = {};
    for (const [file, fc] of Object.entries(coverage)) { out[file] = fc && fc.data ? fc.data : fc; }
    return out;
  }
  const libCoverage = fromJest(rootDir, 'istanbul-lib-coverage');
  const libSourceMaps = fromJest(rootDir, 'istanbul-lib-source-maps');
  const map = (libCoverage.default || libCoverage).createCoverageMap(coverage);
  const remapped = await (libSourceMaps.default || libSourceMaps).createSourceMapStore().transformCoverage(map);
  return remapped.toJSON();
}

/** One test file's coverage, as Jest would report it: `{ kind, coverage }`, or undefined (none measured). */
async function perTestFile(rootDir, testResult) {
  if (Array.isArray(testResult.v8Coverage)) {
    return { kind: 'v8', coverage: await v8ToMap(rootDir, [testResult.v8Coverage]) };
  }
  if (testResult.coverage && typeof testResult.coverage === 'object') {
    return { kind: 'babel', coverage: await babelToMap(rootDir, testResult.coverage) };
  }
  return undefined;
}

/**
 * Files no test loads, counted by Jest's own generateEmptyCoverage with the
 * project's resolved config (as `_addUntestedFiles` does).
 * @param req { rootDir, files, resolvedConfig (the extension's --showConfig file), cacheDirectory, provider }
 */
async function countUntested(req) {
  const { rootDir, files, provider } = req;
  const resolved = JSON.parse(fs.readFileSync(req.resolvedConfig, 'utf8'));
  const jestConfig = fromJest(rootDir, 'jest-config');
  const reportersDir = path.dirname(require.resolve('@jest/reporters/package.json', { paths: jestPaths(rootDir) }));
  const generate = require(path.join(reportersDir, 'build', 'generateEmptyCoverage.js'));
  const generateEmptyCoverage = generate.default || generate;
  // One normalized project config per project (what the batches run with).
  const configs = [];
  for (const [i, input] of resolved.configs.entries()) {
    const { options } = await jestConfig.normalize({ ...resolved.global, ...input, cacheDirectory: req.cacheDirectory }, { $0: 'jest', _: [] }, null, i);
    configs.push(options);
  }
  const inProject = (file, config) => (config.roots && config.roots.length ? config.roots : [config.rootDir])
    .some((r) => { const rel = path.relative(r, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  const globalConfig = { collectCoverage: true, collectCoverageFrom: [], coverageProvider: provider };
  const v8 = [];
  const babel = {};
  for (const file of files) {
    const config = configs.find((c) => inProject(file, c)) || configs[0];
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const res = await generateEmptyCoverage(source, file, globalConfig, config, undefined, undefined);
    if (!res) { continue; }
    if (res.kind === 'V8Coverage') { v8.push([{ codeTransformResult: undefined, result: res.result }]); }
    else if (res.coverage) { babel[file] = typeof res.coverage.toJSON === 'function' ? res.coverage.toJSON() : res.coverage; }
  }
  return {
    ...(v8.length > 0 ? await v8ToMap(rootDir, v8) : {}),
    ...(Object.keys(babel).length > 0 ? await babelToMap(rootDir, babel) : {}),
  };
}

module.exports = { perTestFile, countUntested };
