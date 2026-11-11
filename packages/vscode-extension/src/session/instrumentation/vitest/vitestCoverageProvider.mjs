/**
 * vitestCoverageProvider.mjs — Vitest's `coverage.provider: 'custom'` module
 * Live Test Runner passes on its session runs (with the trace wrapper, whose
 * plugin lets Vite load this folder).
 *
 * It is the project's own provider (@vitest/coverage-v8 or -istanbul, from
 * the project's node_modules: $LTR_VITEST_COVERAGE_REAL), with one addition:
 * besides the usual merged report, it writes each test file's coverage on
 * its own to $LTR_VITEST_COVERAGE_PER_FILE (`<n>.json`:
 * `{ key: <the test files, joined with "," as Vitest keys them>, files: <the
 * same, absolute>, base, project, coverage: <istanbul coverage map> }`). The
 * extension keeps each test file's latest coverage and replaces it when the
 * file runs again, so coverage goes down as well as up.
 *
 * How: Vitest keeps the raw coverage of every test file separately
 * (`coverageFiles`: project → environment → test files → file) until it
 * merges them. For each test file the provider's own `generateCoverage`
 * runs over that one entry — the same conversion, source maps and filters
 * as the merged report, whichever Vitest version or provider. Workers use
 * the real provider's functions unchanged.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.LTR_VITEST_ROOT || process.cwd();
const which = process.env.LTR_VITEST_COVERAGE_REAL === 'istanbul' ? 'istanbul' : 'v8';
const require = createRequire(path.join(root, 'package.json'));
const real = (await import(pathToFileURL(require.resolve(`@vitest/coverage-${which}`)).href)).default;

/** "[LTR:<level>] msg" on stderr → the extension log. */
function ltrLog(level, msg) {
  const rank = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  if ((rank[level] ?? 2) < (rank[process.env.LTR_LOG_LEVEL] ?? 2)) { return; }
  process.stderr.write(`[LTR:${level}] vitest coverage: ${String(msg).replace(/\s*\r?\n\s*/g, ' ↵ ')}\n`);
}

/**
 * $LTR_VITEST_COVERAGE_UNTESTED (a file path): the project's provider's own
 * coverage of the files no test loaded — every file its coverage settings
 * include, with no test's coverage (`allTestsRun`: what a full run adds) — so
 * the extension counts them exactly as `vitest --coverage` does (Vitest 3's v8
 * provider counts every line of such a file; a source scan cannot know that).
 */
async function writeUntested(provider, generate, options) {
  const out = process.env.LTR_VITEST_COVERAGE_UNTESTED;
  if (!out) { return; }
  const started = Date.now();
  const all = provider.coverageFiles;
  // Vitest < 4: batches run with `coverage.all: false` (no untested files in every batch); this pass is the one that adds them.
  const opts = provider.options;
  const hadAll = opts && Object.prototype.hasOwnProperty.call(opts, 'all') ? opts.all : undefined;
  try {
    if (hadAll !== undefined) { opts.all = true; }
    provider.coverageFiles = new Map();
    const map = await generate({ ...options, allTestsRun: true });
    const json = typeof map?.toJSON === 'function' ? map.toJSON() : map;
    fs.writeFileSync(out, JSON.stringify(json ?? {}));
    ltrLog('debug', `${Object.keys(json ?? {}).length} file(s) counted as the provider counts files no test loads in ${Date.now() - started} ms`);
  } catch (err) {
    ltrLog('warn', `could not count the files no test loads (${err && err.message}) — they are counted from their source`);
  } finally {
    provider.coverageFiles = all;
    if (hadAll !== undefined) { opts.all = hadAll; }
  }
}

export default {
  ...real,
  async getProvider() {
    const provider = await real.getProvider();
    const outDir = process.env.LTR_VITEST_COVERAGE_PER_FILE;
    if (!outDir || typeof provider.generateCoverage !== 'function') { return provider; }
    const generate = provider.generateCoverage.bind(provider);
    provider.generateCoverage = async function (options) {
      const all = this.coverageFiles;
      if (!(all instanceof Map)) {
        ltrLog('warn', 'this Vitest keeps no per-test-file coverage (coverageFiles) — coverage is merged per batch');
        return generate(options);
      }
      const started = Date.now();
      let n = 0;
      try {
        if (Array.isArray(this.pendingPromises)) { await Promise.all(this.pendingPromises); this.pendingPromises = []; }
        fs.mkdirSync(outDir, { recursive: true });
        for (const [project, perProject] of all) {
          for (const [environment, byTestFiles] of Object.entries(perProject)) {
            for (const [testFiles, file] of Object.entries(byTestFiles)) {
              // Only this entry, and no untested files (allTestsRun: false).
              this.coverageFiles = new Map([[project, { [environment]: { [testFiles]: file } }]]);
              const map = await generate({ ...options, allTestsRun: false });
              const json = typeof map?.toJSON === 'function' ? map.toJSON() : map;
              // Vitest 3 keys by paths relative to the project's root, 4+ by absolute ones.
              let base = root;
              try { base = this.ctx.getProjectByName?.(project)?.config?.root || this.ctx.config?.root || root; } catch { /* the root */ }
              const files = testFiles.split(',').map((f) => path.resolve(base, f));
              fs.writeFileSync(path.join(outDir, `${n++}.json`), JSON.stringify({ key: testFiles, files, base, project, coverage: json }));
            }
          }
        }
      } catch (err) {
        ltrLog('warn', `per-test-file coverage failed (${err && err.message}) — coverage is merged per batch`);
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* gone */ }
      } finally {
        this.coverageFiles = all;
      }
      ltrLog('debug', `${n} test file(s) measured one by one in ${Date.now() - started} ms`);
      await writeUntested(this, generate, options);
      return generate(options);
    };
    return provider;
  },
};
