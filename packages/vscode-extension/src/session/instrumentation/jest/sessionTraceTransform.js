'use strict';
/**
 * sessionTraceTransform.js — light-trace Jest transform.
 *
 * Instruments source files with:
 *  1. __strace.step(line, file) before each statement — records which lines were hit.
 *  2. __strace.enterTest(name, file) / exitTest() wrapping test callbacks.
 *  3. __strace.enterHook(type, file) / exitHook() wrapping hook callbacks.
 *  4. __cov[fileHash].s/b/f counters for statement/branch/function coverage.
 *     Also writes a coverage manifest JSON to LTR_MANIFEST_DIR.
 *
 * No variable capture, no parameter capture, no console patching.
 * Uses sessionTraceRuntime.js (light trace).
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const RUNTIME_PATH = path.resolve(__dirname, '..', 'shared', 'sessionTraceRuntime.js');
const { sourceMapLookup } = require('../shared/sourceMapLookup.js');

// Log protocol: "[LTR:<level>] msg" lines on stderr are routed by the
// extension's Executor into the "Live Test Runner" log at that level.
// LTR_LOG_LEVEL mirrors the log channel level so quiet levels cost nothing.
const _LTR_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const _ltrMin = _LTR_RANK[process.env.LTR_LOG_LEVEL] ?? _LTR_RANK.info;
function _ltrLog(level, msg) {
  if (_LTR_RANK[level] < _ltrMin) { return; }
  // Keep each message on ONE line — continuation lines would otherwise leak
  // into the raw Jest output. Node's "Require stack:" list is pure noise here.
  const text = String(msg).replace(/\s*Require stack:[\s\S]*$/, '').replace(/\s*\r?\n\s*/g, ' ↵ ');
  process.stderr.write(`[LTR:${level}] transform: ${text}\n`);
}

// Read once and cache — used to invalidate the Jest transform cache when
// this file or the runtime file changes between extension rebuilds.
let _ownHash     = null;
let _runtimeHash = null;

function getOwnHash() {
  if (!_ownHash) {
    try { _ownHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'); }
    catch (_) { _ownHash = 'unknown'; }
  }
  return _ownHash;
}

function getRuntimeHash() {
  if (!_runtimeHash) {
    try { _runtimeHash = crypto.createHash('sha256').update(fs.readFileSync(RUNTIME_PATH)).digest('hex'); }
    catch (_) { _runtimeHash = 'unknown'; }
  }
  return _runtimeHash;
}

/**
 * Coverage id of one version of a file: path + content. Jest's persistent
 * transform cache can serve this file's instrumented code in a later session
 * without calling process() again, so the manifest it needs must already be on
 * disk under the same id — never overwritten by another version of the file.
 */
function _fileHash(filePath, code) {
  return crypto.createHash('sha256').update(filePath).update('\0').update(code).digest('hex').slice(0, 16);
}

// ── Lazy Babel loader ────────────────────────────────────────────────────────

let _rootDir = null;
let _parser, _traverse, _generate, _t;

function loadBabel(rootDir) {
  if (_rootDir === rootDir && _parser) { return true; }
  try {
    const resolve = (id) => require.resolve(id, { paths: [rootDir, __dirname] });

    // Load traverse first — it's always available and we can use its pnpm virtual-store
    // directory to resolve sibling packages (@babel/types, @babel/generator) that may
    // not be directly linked in the extension's node_modules.
    const traversePath = resolve('@babel/traverse');
    _traverse = require(traversePath);
    if (_traverse && _traverse.default) { _traverse = _traverse.default; }

    // Build a fallback resolver rooted at @babel/traverse's real disk location so that
    // @babel/types and @babel/generator are found even when they're not directly hoisted
    // into the extension's node_modules (pnpm workspace isolation).
    let traverseReal;
    try { traverseReal = fs.realpathSync(traversePath); } catch (_) { traverseReal = traversePath; }
    const traverseDir = path.dirname(traverseReal);
    const resolveWithFallback = (id) => {
      try { return require.resolve(id, { paths: [rootDir, __dirname] }); }
      catch (_) { return require.resolve(id, { paths: [traverseDir] }); }
    };

    _parser   = require(resolveWithFallback('@babel/parser'));
    _generate = require(resolveWithFallback('@babel/generator'));
    _t        = require(resolveWithFallback('@babel/types'));
    if (_generate && _generate.default) { _generate = _generate.default; }
    _rootDir = rootDir;
    return true;
  } catch (e) {
    _ltrLog('error', `could not load Babel (@babel/parser, traverse, generator, types) for ${rootDir} — coverage and smart reruns are disabled: ${e.message}`);
    return false;
  }
}

// ── Chain through the project's existing transformer ─────────────────────────

// Transformers that run the real TypeScript compiler (tsc / SWC) require clean
// source as input — they reject the __covF/__strace globals we inject via Babel.
// For these we must transpile first (TS→JS), then instrument the resulting JS.
const STRICT_TRANSFORMER_PATTERNS = [
  /\bts-jest\b/,
  /@swc\/jest\b/,
  /\bbabel-plugin-jest-hoist\b/,
  /\besbuild-jest\b/,
];

function isStrictTransformer(moduleName) {
  return STRICT_TRANSFORMER_PATTERNS.some((re) => re.test(moduleName));
}

/** A transformer module's export → an object with process / processAsync. */
function transformerOf(mod, transformerConfig) {
  if (!mod) { return null; }
  // Some transformers (ts-jest v28+) don't export process directly.
  // They expose a createTransformer factory on the default export.
  if (typeof mod.process === 'function' || typeof mod.processAsync === 'function') { return mod; }
  if (mod.default && (typeof mod.default.process === 'function' || typeof mod.default.processAsync === 'function')) { return mod.default; }
  if (mod.default && typeof mod.default.createTransformer === 'function') { return mod.default.createTransformer(transformerConfig || {}); }
  if (typeof mod.createTransformer === 'function') { return mod.createTransformer(transformerConfig || {}); }
  return null;
}

/**
 * Resolves a project transformer: `{ resolvedPath, transformerConfig, downstreamOptions }`.
 */
function transformerSetup(moduleName, options, transforms) {
  // Resolve from the project root first so ts-jest / @swc/jest / etc. are found
  // in the project's node_modules even though they are not in the extension's.
  const rootDir = options && options.config && options.config.rootDir;
  let resolvedPath = moduleName;
  try {
    resolvedPath = require.resolve(moduleName, { paths: [rootDir, __dirname].filter(Boolean) });
  } catch (resolveErr) {
    _ltrLog('warn', `could not resolve transformer "${moduleName}": ${resolveErr.message}`);
  }
  // Extract per-transformer config (index 2 of the transform entry, e.g. { tsconfig: '...' }).
  // Jest passes this as options.transformerConfig — ts-jest, @swc/jest etc. read it from there.
  const entry = transforms.find(e => e[1] === moduleName);
  const transformerConfig = (entry && entry[2]) || undefined;
  const downstreamOptions = {
    ...options,
    ...(transformerConfig !== undefined ? { transformerConfig } : {}),
    config: { ...options.config, transform: transforms.filter(e => e[1] !== moduleName) },
  };
  return { resolvedPath, transformerConfig, downstreamOptions };
}

function resultOf(result) {
  if (result && typeof result.code === 'string') { return { code: result.code, map: result.map }; }
  if (typeof result === 'string') { return { code: result }; }
  return null;
}

function invokeTransformer(moduleName, sourceCode, sourcePath, options, transforms) {
  const { resolvedPath, transformerConfig, downstreamOptions } = transformerSetup(moduleName, options, transforms);
  let transformer;
  try {
    transformer = transformerOf(require(resolvedPath), transformerConfig);
  } catch (requireErr) {
    _ltrLog('warn', `could not load transformer ${resolvedPath}: ${requireErr.message}`);
    return null;
  }
  if (!transformer || typeof transformer.process !== 'function') { return null; }
  return resultOf(transformer.process(sourceCode, sourcePath, downstreamOptions));
}

/**
 * invokeTransformer for Jest's ESM mode (processAsync): the transformer's
 * processAsync when it has one (svelte-jester for Svelte 4+), else process.
 * ESM-only transformers are loaded with import().
 */
async function invokeTransformerAsync(moduleName, sourceCode, sourcePath, options, transforms) {
  const { resolvedPath, transformerConfig, downstreamOptions } = transformerSetup(moduleName, options, transforms);
  let transformer;
  try {
    let mod;
    try { mod = require(resolvedPath); } catch (requireErr) {
      if (!/ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE|Unexpected token 'export'|Cannot use import statement/.test(`${requireErr.code} ${requireErr.message}`)) { throw requireErr; }
      mod = await import(require('url').pathToFileURL(resolvedPath).href);
    }
    transformer = transformerOf(mod, transformerConfig);
  } catch (loadErr) {
    _ltrLog('warn', `could not load transformer ${resolvedPath}: ${loadErr.message}`);
    return null;
  }
  if (!transformer) { return null; }
  if (typeof transformer.processAsync === 'function') {
    return resultOf(await transformer.processAsync(sourceCode, sourcePath, downstreamOptions));
  }
  return typeof transformer.process === 'function' ? resultOf(transformer.process(sourceCode, sourcePath, downstreamOptions)) : null;
}

/**
 * The project's own transform of a file: `{ code, map }`, or null when no
 * transform matches or it fails. `async`: Jest's ESM mode (processAsync) —
 * returns a promise.
 */
function projectTransform(sourceCode, sourcePath, options, async = false) {
  if (!options || !options.config) { return null; }
  let transforms = options.config.transform;
  if (!Array.isArray(transforms)) {
    transforms = Object.entries(transforms || {}).map(([p, v]) => Array.isArray(v) ? [p, ...v] : [p, v]);
  }
  const entry = findMatchingTransform(transforms, sourcePath);
  if (!entry) { return async ? Promise.resolve(null) : null; }
  const failed = (e) => {
    _ltrLog('warn', `project transformer "${entry[1]}" failed on ${sourcePath}: ${e.message}`);
    return null;
  };
  if (async) {
    return invokeTransformerAsync(entry[1], sourceCode, sourcePath, options, transforms).catch(failed);
  }
  try {
    return invokeTransformer(entry[1], sourceCode, sourcePath, options, transforms);
  } catch (e) {
    return failed(e);
  }
}

function chainTransform(sourceCode, sourcePath, options) {
  if (!options || !options.config) { return sourceCode; }

  let transforms = options.config.transform;
  if (!Array.isArray(transforms)) {
    transforms = Object.entries(transforms || {}).map(([p, v]) =>
      Array.isArray(v) ? [p, ...v] : [p, v],
    );
  }

  for (const entry of transforms) {
    const [pattern, moduleName] = entry;
    if (moduleName === __filename) { continue; }
    if (!new RegExp(pattern).test(sourcePath)) { continue; }

    try {
      const result = invokeTransformer(moduleName, sourceCode, sourcePath, options, transforms);
      if (result !== null) { return result.code; }
    } catch (_e) {
      _ltrLog('warn', `project transformer "${moduleName}" failed on ${sourcePath}: ${_e.message}`);
    }
    break;
  }

  // babel-jest fallback for CRA / projects with no matching transform entry.
  // Resolved through Node's module lookup — a fixed node_modules/ path breaks
  // under pnpm / Yarn PnP, and presets that are not installed are skipped.
  const rootDir = options && options.config && options.config.rootDir;
  if (rootDir) {
    const tryResolve = (id) => { try { return require.resolve(id, { paths: [rootDir] }); } catch (_) { return null; } };
    try {
      const babelJest = require(tryResolve('babel-jest') || 'babel-jest');
      const createTransformer = babelJest.createTransformer
        || (babelJest.default && babelJest.default.createTransformer);
      if (createTransformer) {
        const reactApp = tryResolve('babel-preset-react-app');
        let presets;
        if (reactApp) {
          presets = [[reactApp, { runtime: 'automatic' }]];
        } else {
          presets = [];
          const env = tryResolve('@babel/preset-env');
          const react = tryResolve('@babel/preset-react');
          const ts = /\.(ts|tsx)$/.test(sourcePath) ? tryResolve('@babel/preset-typescript') : null;
          if (env) { presets.push([env, { targets: { node: 'current' } }]); }
          if (react) { presets.push([react, {}]); }
          if (ts) { presets.push([ts, { allExtensions: true, isTSX: /\.tsx$/.test(sourcePath) }]); }
        }
        // No presets installed: babel-jest with the project's own Babel config (Jest's default).
        const transformer = createTransformer(presets.length ? { configFile: false, presets } : {});
        const result = transformer.process(sourceCode, sourcePath, options);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      // No file name in the warning: the cause is the same for every file, so
      // identical lines collapse into one "repeated N times" entry.
      _ltrLog('warn', `babel-jest fallback failed (files run untranspiled): ${_e.message}`);
      _ltrLog('debug', `babel-jest fallback failed on ${sourcePath}`);
    }
  }

  return sourceCode;
}

// Returns the first matching transform entry for a source file, or null.
function findMatchingTransform(transforms, sourcePath) {
  for (const entry of transforms) {
    const [pattern, moduleName] = entry;
    if (moduleName === __filename) { continue; }
    if (new RegExp(pattern).test(sourcePath)) { return entry; }
  }
  return null;
}

// ── AST node builders ────────────────────────────────────────────────────────

function makeStepCall(lineNo, filePath) {
  const t = _t;
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__strace'), t.identifier('step')),
      [t.numericLiteral(lineNo), t.stringLiteral(filePath)],
    ),
  );
}

function wrapBodyWithContext(bodyNode, enterCall, exitCall) {
  const t = _t;
  const wrapped = t.tryStatement(
    t.blockStatement(bodyNode.body),
    null,
    t.blockStatement([t.expressionStatement(exitCall)]),
  );
  bodyNode.body = [t.expressionStatement(enterCall), wrapped];
}

function makeEnterTest(name, filePath) {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('enterTest')),
    [_t.stringLiteral(name), _t.stringLiteral(filePath)],
  );
}

function makeExitTest() {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('exitTest')),
    [],
  );
}

function makeEnterHook(hookType, filePath) {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('enterHook')),
    [_t.stringLiteral(hookType), _t.stringLiteral(filePath)],
  );
}

function makeExitHook() {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('exitHook')),
    [],
  );
}

// ── Jest call classification ─────────────────────────────────────────────────

const HOOK_NAMES     = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll']);
const TEST_NAMES     = new Set(['it', 'test']);
const DESCRIBE_NAMES = new Set(['describe']);

function classifyCall(node) {
  const t = _t;
  let callee = node.callee;
  let baseName = null;

  if (t.isIdentifier(callee)) {
    baseName = callee.name;
  } else if (t.isMemberExpression(callee)) {
    let obj = callee;
    while (t.isMemberExpression(obj)) { obj = obj.object; }
    if (t.isIdentifier(obj)) { baseName = obj.name; }
  } else if (t.isCallExpression(callee)) {
    let inner = callee.callee;
    while (t.isMemberExpression(inner)) { inner = inner.object; }
    if (t.isIdentifier(inner)) { baseName = inner.name; }
  }

  if (!baseName) { return null; }

  if (TEST_NAMES.has(baseName)) {
    const nameArg = node.arguments[0];
    let testName = null;
    if (t.isStringLiteral(nameArg)) { testName = nameArg.value; }
    else if (t.isTemplateLiteral(nameArg) && nameArg.quasis.length === 1) {
      testName = nameArg.quasis[0].value.cooked ?? '';
    } else if (nameArg) {
      testName = '<dynamic>';
    }
    return { kind: 'test', name: testName };
  }
  if (HOOK_NAMES.has(baseName)) { return { kind: 'hook', name: baseName }; }
  if (DESCRIBE_NAMES.has(baseName)) {
    const nameArg = node.arguments[0];
    let suiteName = null;
    if (t.isStringLiteral(nameArg)) { suiteName = nameArg.value; }
    else if (t.isTemplateLiteral(nameArg) && nameArg.quasis.length === 1) {
      suiteName = nameArg.quasis[0].value.cooked ?? '';
    } else if (nameArg) {
      suiteName = '<dynamic>';
    }
    return { kind: 'describe', name: suiteName };
  }
  return null;
}

function findCallbackArg(args) {
  for (const arg of args) {
    if (_t.isFunctionExpression(arg) || _t.isArrowFunctionExpression(arg)) {
      return arg;
    }
  }
  return null;
}

// ── Coverage AST node builders ───────────────────────────────────────────────

/** __covF.s["sN"] += 1  as a Statement */
function makeCovStmt(stmtId) {
  return _t.expressionStatement(makeCovStmtExpr(stmtId));
}

/** __covF.s["sN"] += 1  as an Expression */
function makeCovStmtExpr(stmtId) {
  const t = _t;
  return t.assignmentExpression(
    '+=',
    t.memberExpression(
      t.memberExpression(t.identifier('__covF'), t.identifier('s')),
      t.stringLiteral(stmtId),
      true,
    ),
    t.numericLiteral(1),
  );
}

/** __covF.f["fN"] += 1  as a Statement */
function makeCovFn(fnId) {
  return _t.expressionStatement(makeCovFnExpr(fnId));
}

/** __covF.f["fN"] += 1  as an Expression */
function makeCovFnExpr(fnId) {
  const t = _t;
  return t.assignmentExpression(
    '+=',
    t.memberExpression(
      t.memberExpression(t.identifier('__covF'), t.identifier('f')),
      t.stringLiteral(fnId),
      true,
    ),
    t.numericLiteral(1),
  );
}

/** __strace.step(line, file)  as an Expression (no statement wrapper) */
function makeStepCallExpr(lineNo, filePath) {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('step')),
    [_t.numericLiteral(lineNo), _t.stringLiteral(filePath)],
  );
}

/** __covF.b["bN"][armIdx]++ as a Statement */
function makeCovBranch(branchId, armIdx) {
  const t = _t;
  return t.expressionStatement(makeCovBranchExpr(branchId, armIdx));
}

/** __covF.b["bN"][armIdx] += 1  as an Expression (for use inside SequenceExpression) */
function makeCovBranchExpr(branchId, armIdx) {
  const t = _t;
  return t.assignmentExpression(
    '+=',
    t.memberExpression(
      t.memberExpression(
        t.memberExpression(t.identifier('__covF'), t.identifier('b')),
        t.stringLiteral(branchId),
        true,
      ),
      t.numericLiteral(armIdx),
      true,
    ),
    t.numericLiteral(1),
  );
}

/**
 * Walk up from nodePath while the parent is a non-optional continuation of the
 * same optional chain (OptionalMemberExpression/OptionalCallExpression with
 * optional:false).  Returns the outermost path in that segment.
 *
 * Example: `a?.b.c` — starting at `a?.b` (optional:true), the parent is
 * `OptionalMemberExpression(.c, optional:false)` which is a continuation, so
 * the segment top is that parent.
 */
function findChainSegmentTop(nodePath) {
  let top = nodePath;
  for (;;) {
    const pp = top.parentPath;
    const pn = pp && pp.node;
    if (!pn) { break; }
    if (
      (pn.type === 'OptionalMemberExpression' && !pn.optional && pn.object === top.node) ||
      (pn.type === 'OptionalCallExpression'   && !pn.optional && pn.callee === top.node)
    ) { top = pp; } else { break; }
  }
  return top;
}

/**
 * Build a non-optional MemberExpression/CallExpression chain for the segment
 * from branchNodePath up to (and including) chainTopPath, using baseExpr as
 * the receiver instead of the original object.
 *
 * Steps are collected in order from inner (branch point) to outer (chain top),
 * so they are applied left-to-right: baseExpr → .b → .c → () etc.
 */
function buildChainExpr(branchNodePath, chainTopPath, baseExpr) {
  const t = _t;
  const steps = [];
  let cur = branchNodePath;
  for (;;) {
    steps.push(cur.node);
    if (cur === chainTopPath) { break; }
    cur = cur.parentPath;
  }
  let expr = baseExpr;
  for (const n of steps) {
    if (n.type === 'OptionalMemberExpression') {
      expr = t.memberExpression(expr, n.property, n.computed);
    } else {
      expr = t.callExpression(expr, n.arguments);
    }
  }
  return expr;
}

/**
 * Collect all leaves of a same-operator logical chain.
 * `a || b || c` (left-nested) and `a || (b || c)` (right-nested) both yield [a, b, c].
 * Stops at nodes with a different operator (they are treated as atomic leaves).
 */
function collectLogicalLeaves(node, op) {
  if (node.type !== 'LogicalExpression' || node.operator !== op) { return [node]; }
  return [...collectLogicalLeaves(node.left, op), ...collectLogicalLeaves(node.right, op)];
}

/**
 * Build the coverage preamble block injected at the top of the file:
 *   if (!globalThis.__cov) { globalThis.__cov = {}; }
 *   if (!globalThis.__cov[FILE_HASH]) {
 *     globalThis.__cov[FILE_HASH] = { s: { s0: 0, ... }, b: { b0: [0,0], ... }, f: { f0: 0, ... } };
 *   }
 *   const __covF = globalThis.__cov[FILE_HASH];
 */
function buildCovPreamble(fileHash, manifest) {
  const t = _t;

  // s object: { s0: 0, s1: 0, ... }
  const sProps = Object.keys(manifest.statements).map((id) =>
    t.objectProperty(t.stringLiteral(id), t.numericLiteral(0)),
  );
  // b object: { b0: [0, 0], ... }
  const bProps = Object.entries(manifest.branches).map(([id, b]) =>
    t.objectProperty(
      t.stringLiteral(id),
      t.arrayExpression(Array.from({ length: b.arms }, () => t.numericLiteral(0))),
    ),
  );
  // f object: { f0: 0, ... }
  const fProps = Object.keys(manifest.functions).map((id) =>
    t.objectProperty(t.stringLiteral(id), t.numericLiteral(0)),
  );

  const covInitObj = t.objectExpression([
    t.objectProperty(t.identifier('s'), t.objectExpression(sProps)),
    t.objectProperty(t.identifier('b'), t.objectExpression(bProps)),
    t.objectProperty(t.identifier('f'), t.objectExpression(fProps)),
  ]);

  // if (!globalThis.__cov) { globalThis.__cov = {}; }
  const ensureGlobal = t.ifStatement(
    t.unaryExpression('!', t.memberExpression(t.identifier('globalThis'), t.identifier('__cov'))),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(t.identifier('globalThis'), t.identifier('__cov')),
          t.objectExpression([]),
        ),
      ),
    ]),
  );

  // if (!globalThis.__cov[HASH]) { globalThis.__cov[HASH] = { ... }; }
  const ensureFile = t.ifStatement(
    t.unaryExpression(
      '!',
      t.memberExpression(
        t.memberExpression(t.identifier('globalThis'), t.identifier('__cov')),
        t.stringLiteral(fileHash),
        true,
      ),
    ),
    t.blockStatement([
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(
            t.memberExpression(t.identifier('globalThis'), t.identifier('__cov')),
            t.stringLiteral(fileHash),
            true,
          ),
          covInitObj,
        ),
      ),
    ]),
  );

  // var __covF = globalThis.__cov[HASH];  (var avoids TDZ when babel re-orders code)
  const covFDecl = t.variableDeclaration('var', [
    t.variableDeclarator(
      t.identifier('__covF'),
      t.memberExpression(
        t.memberExpression(t.identifier('globalThis'), t.identifier('__cov')),
        t.stringLiteral(fileHash),
        true,
      ),
    ),
  ]);

  return [ensureGlobal, ensureFile, covFDecl];
}

// ── Main AST instrumentation ─────────────────────────────────────────────────

/**
 * Moves every node's location to the file's own source through `lookup`
 * (sourceMapLookup): code compiled from a component (.vue, .svelte, …) then
 * reports the component's lines. Nodes the map does not lead back to (code
 * the compiler added) lose their location — they get no counter and no step.
 */
function remapLocations(ast, lookup) {
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) { return; }
    seen.add(node);
    if (Array.isArray(node)) { for (const n of node) { visit(n); } return; }
    if (typeof node.type === 'string' && node.loc && node.loc.start) {
      const st = lookup(node.loc.start.line - 1, node.loc.start.column);
      if (!st) {
        node.loc = null;
      } else {
        let en = node.loc.end ? lookup(node.loc.end.line - 1, Math.max(0, node.loc.end.column - 1)) : undefined;
        if (!en || en.line < st.line || (en.line === st.line && en.column < st.column)) { en = st; }
        else { en = { line: en.line, column: en.column + 1 }; }
        node.loc = { start: { line: st.line, column: st.column }, end: { line: en.line, column: en.column } };
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'tokens') { continue; }
      const v = node[key];
      if (v && typeof v === 'object') { visit(v); }
    }
  };
  visit(ast.program);
}

/**
 * @param {string} code
 * @param {string} sourcePath
 * @param {Function} [lookup] generated → original positions (sourceMapLookup)
 *   when `code` was compiled from another language (components)
 */
function instrumentAST(code, sourcePath, lookup) {
  const t = _t;
  let ast;
  try {
    ast = _parser.parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (e) {
    _ltrLog('debug', `parse failed for ${sourcePath}: ${e.message}`);
    return null;
  }

  if (lookup) { remapLocations(ast, lookup); }
  /** Compiled code (components) that the map does not lead back to: not counted. */
  const unmapped = (node) => !!lookup && !(node && node.loc);

  // Coverage manifest — built during the walk below
  const fileHash = _fileHash(sourcePath, code);
  const manifest = {
    filePath: sourcePath,
    statements: /** @type {Record<string, {start:{line:number,col:number},end:{line:number,col:number}}>} */ ({}),
    branches:   /** @type {Record<string, {type:string,line:number,arms:number}>} */ ({}),
    functions:  /** @type {Record<string, {name:string,start:{line:number},end:{line:number}}>} */ ({}),
  };
  let sIdx = 0, bIdx = 0, fIdx = 0;
  // Tracks ConditionalExpression nodes we generate for optional-chaining so the
  // ConditionalExpression:exit visitor doesn't add a second (cond-expr) counter.
  const generatedCondExprs = new WeakSet();
  // Temp var names needed for optional-chain instrumentation of non-identifier objects.
  const tempVarNames = [];
  // Guards against double-registration when replaceWith() triggers re-traversal.
  const registeredFunctions = new WeakSet();

  // Some chain segments end up detached by earlier in-place rewrites (their
  // path has no container any more) and Babel throws "Container is falsy".
  // That used to fail the whole test file; now that one `?.` is just not
  // branch-counted.
  const replaceOptionalChain = (topPath, replacement, bId, node) => {
    if (!topPath.container) {
      delete manifest.branches[bId];
      _ltrLog('debug', `skipped branch counting for an optional chain at ${sourcePath}:${node.loc?.start?.line ?? '?'} (detached node)`);
      return;
    }
    try {
      topPath.replaceWith(replacement);
    } catch (e) {
      delete manifest.branches[bId];
      _ltrLog('debug', `skipped branch counting for an optional chain at ${sourcePath}:${node.loc?.start?.line ?? '?'}: ${e.message}`);
    }
  };

  // Pass 1: wrap test/hook callbacks with enter/exit context calls
  const describeStack = [];
  _traverse(ast, {
    CallExpression: {
      enter(nodePath) {
        const info = classifyCall(nodePath.node);
        if (!info) { return; }

        const cb = findCallbackArg(nodePath.node.arguments);
        if (!cb || !t.isBlockStatement(cb.body)) {
          if (info.kind === 'describe') { describeStack.push(info.name ?? '<suite>'); }
          return;
        }

        if (info.kind === 'describe') {
          describeStack.push(info.name ?? '<suite>');
        } else if (info.kind === 'test') {
          const fullName = [...describeStack, info.name || '<unknown>'].join(' ');
          wrapBodyWithContext(cb.body, makeEnterTest(fullName, sourcePath), makeExitTest());
        } else if (info.kind === 'hook') {
          wrapBodyWithContext(cb.body, makeEnterHook(info.name, sourcePath), makeExitHook());
        }
      },
      exit(nodePath) {
        const info = classifyCall(nodePath.node);
        if (info?.kind === 'describe') { describeStack.pop(); }
      },
    },
  });

  // Pass 2: inject __strace.step() + coverage counters before each statement
  const insertions = [];
  _traverse(ast, {
    // Function coverage — inject at start of function body
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ObjectMethod'(nodePath) {
      const node = nodePath.node;
      // Guard: replaceWith() on an ancestor re-traverses descendants — skip if already registered.
      if (registeredFunctions.has(node)) { return; }
      registeredFunctions.add(node);
      const body = node.body;

      // Skip functions inside jest.mock() factories — babel-plugin-jest-hoist moves
      // those calls before our __covF preamble, so __covF would be undefined at runtime.
      const insideJestMock = nodePath.findParent((p) => {
        if (!p.isCallExpression()) { return false; }
        const callee = p.node.callee;
        return (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: 'jest' }) &&
          (t.isIdentifier(callee.property, { name: 'mock' }) ||
           t.isIdentifier(callee.property, { name: 'doMock' }))
        );
      });
      if (insideJestMock) { return; }
      if (unmapped(node)) { return; }

      const fnId = `f${fIdx++}`;
      const loc  = node.loc;
      manifest.functions[fnId] = {
        name:  node.id?.name ?? node.key?.name ?? '<anonymous>',
        start: { line: loc?.start?.line ?? 0 },
        end:   { line: loc?.end?.line   ?? 0 },
      };

      if (t.isBlockStatement(body)) {
        // Block-body function — prepend counter to the body
        body.body.unshift(makeCovFn(fnId));
      } else {
        // Expression-body arrow: (x) => expr
        // Istanbul counts this as a function call AND as a statement for the body expression.
        const bodyLine = body.loc?.start?.line ?? 0;
        const sId = bodyLine !== 0 ? `s${sIdx++}` : null;
        if (sId) {
          manifest.statements[sId] = {
            start: { line: body.loc.start.line, col: body.loc.start.column },
            end:   { line: body.loc.end.line,   col: body.loc.end.column },
          };
        }
        // Wrap body: (x) => (step(line), fnCounter++, stmtCounter++, expr)
        const parts = [makeCovFnExpr(fnId)];
        if (sId) {
          parts.push(makeStepCallExpr(bodyLine, sourcePath));
          parts.push(makeCovStmtExpr(sId));
        }
        parts.push(body);
        node.body = t.sequenceExpression(parts);
      }
    },

    // Default function parameter values — Istanbul tracks these as 1-arm branches.
    AssignmentPattern(nodePath) {
      const parentType = nodePath.parent?.type;
      if (parentType !== 'FunctionDeclaration' && parentType !== 'FunctionExpression' &&
          parentType !== 'ArrowFunctionExpression' && parentType !== 'ClassMethod' &&
          parentType !== 'ObjectMethod') { return; }
      if (unmapped(nodePath.node)) { return; }
      const bId  = `b${bIdx++}`;
      const line = nodePath.node.loc?.start?.line ?? 0;
      manifest.branches[bId] = { type: 'default-arg', line, arms: 1 };
      // Wrap the default value so the counter fires each time the default is used
      nodePath.node.right = t.sequenceExpression([makeCovBranchExpr(bId, 0), nodePath.node.right]);
    },

    // Branch coverage — conditional (ternary) expressions
    // Uses exit so inner ternaries are instrumented before the outer wrapper is added.
    // Skips ConditionalExpression nodes we generated for optional-chaining (already counted).
    ConditionalExpression: {
      exit(nodePath) {
        if (generatedCondExprs.has(nodePath.node)) { return; }
        const node = nodePath.node;
        if (unmapped(node)) { return; }
        const bId  = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'cond-expr', line: node.loc?.start?.line ?? 0, arms: 2 };
        node.consequent = t.sequenceExpression([makeCovBranchExpr(bId, 0), node.consequent]);
        node.alternate  = t.sequenceExpression([makeCovBranchExpr(bId, 1), node.alternate]);
      },
    },

    // Branch coverage — optional chaining (?.) and optional calls (fn?.())
    //
    // Key invariant: we replace the ENTIRE chain segment at the `?.` branch
    // point (including any non-optional continuations like `.length` that follow
    // it), so that the null guard wraps the full expression.
    //
    // Example: `a?.b.c`  → `(_t = a) == null ? undefined : _t.b.c`
    //          (NOT `(a == null ? undefined : a.b).c` which would throw if a is null)
    //
    // We use `enter` (top-down) so we visit outer `?.` before inner ones; after
    // replaceWith() Babel re-traverses the replacement and processes inner `?.`.
    OptionalMemberExpression: {
      enter(nodePath) {
        if (!nodePath.node.optional) { return; } // non-optional continuations are handled by their `?.` ancestor
        const node = nodePath.node;
        if (unmapped(node)) { return; }
        const topPath = findChainSegmentTop(nodePath);
        const bId = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'optional-chaining', line: node.loc?.start?.line ?? 0, arms: 2 };
        const obj = node.object;
        let checkExpr, useExpr;
        if (t.isIdentifier(obj)) {
          checkExpr = obj;
          useExpr   = t.identifier(obj.name);
        } else {
          const tmpName = `_ltrOc${bIdx}`;
          tempVarNames.push(tmpName);
          checkExpr = t.assignmentExpression('=', t.identifier(tmpName), obj);
          useExpr   = t.identifier(tmpName);
        }
        const truthy = buildChainExpr(nodePath, topPath, useExpr);
        const replacement = t.conditionalExpression(
          t.binaryExpression('==', checkExpr, t.nullLiteral()),
          t.sequenceExpression([makeCovBranchExpr(bId, 1), t.identifier('undefined')]),
          t.sequenceExpression([makeCovBranchExpr(bId, 0), truthy]),
        );
        generatedCondExprs.add(replacement);
        replaceOptionalChain(topPath, replacement, bId, node);
      },
    },

    // Handles standalone optional calls: `fn?.()` where the callee is not an
    // OptionalMemberExpression (those are covered by the visitor above).
    OptionalCallExpression: {
      enter(nodePath) {
        const node = nodePath.node;
        if (!node.optional) { return; }
        if (t.isOptionalMemberExpression(node.callee)) { return; } // handled by OptionalMemberExpression visitor
        if (unmapped(node)) { return; }
        const topPath = findChainSegmentTop(nodePath);
        const bId = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'optional-chaining', line: node.loc?.start?.line ?? 0, arms: 2 };
        const callee = node.callee;
        let checkExpr, useExpr;
        if (t.isIdentifier(callee)) {
          checkExpr = callee;
          useExpr   = t.identifier(callee.name);
        } else {
          const tmpName = `_ltrOc${bIdx}`;
          tempVarNames.push(tmpName);
          checkExpr = t.assignmentExpression('=', t.identifier(tmpName), callee);
          useExpr   = t.identifier(tmpName);
        }
        const truthy = buildChainExpr(nodePath, topPath, useExpr);
        const replacement = t.conditionalExpression(
          t.binaryExpression('==', checkExpr, t.nullLiteral()),
          t.sequenceExpression([makeCovBranchExpr(bId, 1), t.identifier('undefined')]),
          t.sequenceExpression([makeCovBranchExpr(bId, 0), truthy]),
        );
        generatedCondExprs.add(replacement);
        replaceOptionalChain(topPath, replacement, bId, node);
      },
    },

    // Branch coverage — logical expressions (||, &&, ??)
    // A chain like `a || b || c` is one branch group with N arms (one per operand),
    // matching Istanbul's binary-expr semantics exactly.
    // Uses exit so inner chains (different operator) are instrumented first.
    LogicalExpression: {
      exit(nodePath) {
        const node = nodePath.node;
        // Skip inner nodes of a same-operator chain — the root handles the whole chain
        if (nodePath.parent?.type === 'LogicalExpression' &&
            nodePath.parent.operator === node.operator) { return; }
        if (unmapped(node)) { return; }

        const leaves = collectLogicalLeaves(node, node.operator);
        const bId    = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'binary-expr', line: node.loc?.start?.line ?? 0, arms: leaves.length };

        let armIdx = 0;
        const wrapInPlace = (n) => {
          if (n.type !== 'LogicalExpression' || n.operator !== node.operator) {
            // Leaf — return a new SequenceExpression wrapping the original node
            return t.sequenceExpression([makeCovBranchExpr(bId, armIdx++), n]);
          }
          // Chain node — mutate children in place and return the same object
          n.left  = wrapInPlace(n.left);
          n.right = wrapInPlace(n.right);
          return n;
        };
        wrapInPlace(node); // mutates the chain in place; no replaceWith → no re-traversal
      },
    },

    // Branch coverage — switch/case
    // Istanbul creates one branch group per SwitchStatement with one arm per SwitchCase.
    SwitchStatement(nodePath) {
      const node = nodePath.node;
      const cases = node.cases;
      if (!cases.length || unmapped(node)) { return; }
      const bId = `b${bIdx++}`;
      manifest.branches[bId] = { type: 'switch', line: node.loc?.start?.line ?? 0, arms: cases.length };
      cases.forEach((switchCase, armIdx) => {
        switchCase.consequent.unshift(makeCovBranch(bId, armIdx));
      });
    },

    // Branch coverage — if/else
    IfStatement(nodePath) {
      const node = nodePath.node;
      if (unmapped(node)) { return; }
      const bId  = `b${bIdx++}`;
      manifest.branches[bId] = { type: 'if', line: node.loc?.start?.line ?? 0, arms: 2 };

      // Ensure branches are block statements before inserting
      if (!t.isBlockStatement(node.consequent)) {
        node.consequent = t.blockStatement([node.consequent]);
      }
      node.consequent.body.unshift(makeCovBranch(bId, 0));

      const elseBody = node.alternate ?? t.blockStatement([]);
      if (!t.isBlockStatement(elseBody)) {
        node.alternate = t.blockStatement([elseBody, makeCovBranch(bId, 1)]);
      } else {
        elseBody.body.unshift(makeCovBranch(bId, 1));
        if (!node.alternate) { node.alternate = elseBody; }
      }
    },

    Statement: {
      exit(nodePath) {
        const node = nodePath.node;

        // Skip statements inside jest.mock() factories AND the jest.mock() call itself.
        // babel-plugin-jest-hoist moves jest.mock() to the top of the file; if we prepend
        // a counter to it, the counter can end up before the __covF preamble.
        const isJestMockCall = (
          t.isExpressionStatement(node) &&
          t.isCallExpression(node.expression) &&
          (() => {
            const callee = node.expression.callee;
            if (t.isMemberExpression(callee)) {
              return (
                t.isIdentifier(callee.object, { name: 'jest' }) &&
                (t.isIdentifier(callee.property, { name: 'mock' }) ||
                 t.isIdentifier(callee.property, { name: 'doMock' }) ||
                 t.isIdentifier(callee.property, { name: 'unmock' }) ||
                 t.isIdentifier(callee.property, { name: 'resetModules' }))
              );
            }
            return false;
          })()
        );
        if (isJestMockCall) { return; }

        const insideJestMock = nodePath.findParent((p) => {
          if (!p.isCallExpression()) { return false; }
          const callee = p.node.callee;
          return (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object, { name: 'jest' }) &&
            (t.isIdentifier(callee.property, { name: 'mock' }) ||
             t.isIdentifier(callee.property, { name: 'doMock' }))
          );
        });
        if (insideJestMock) { return; }

        // SwitchStatement and LabeledStatement are not counted by Istanbul as plain statements.
        // IfStatement, ForStatement, WhileStatement, TryStatement etc. ARE counted by Istanbul.
        if (t.isSwitchStatement(node) || t.isLabeledStatement(node)) { return; }

        if (t.isImportDeclaration(node)) { return; }
        if (t.isExportDeclaration(node)) { return; }
        // Istanbul does not count function/class declarations or bare blocks as statements
        if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) { return; }
        if (t.isBlockStatement(node)) { return; }

        const lineNo = (node.loc && node.loc.start && node.loc.start.line) || 0;
        if (lineNo === 0) { return; }

        const sId = `s${sIdx++}`;
        manifest.statements[sId] = {
          start: { line: node.loc.start.line, col: node.loc.start.column },
          end:   { line: node.loc.end.line,   col: node.loc.end.column },
        };

        insertions.push({
          nodePath,
          stepNode: makeStepCall(lineNo, sourcePath),
          covNode:  makeCovStmt(sId),
        });
      },
    },
  });

  for (let i = insertions.length - 1; i >= 0; i--) {
    const { nodePath, stepNode, covNode } = insertions[i];
    try {
      nodePath.insertBefore(covNode);
      nodePath.insertBefore(stepNode);
    } catch (_e) {}
  }

  // Inject temp vars needed for optional-chaining instrumentation of non-identifier objects
  if (tempVarNames.length > 0) {
    const varDecl = t.variableDeclaration('var',
      tempVarNames.map((name) => t.variableDeclarator(t.identifier(name))),
    );
    ast.program.body.unshift(varDecl);
  }

  // Inject coverage preamble at the top of the program body
  const preamble = buildCovPreamble(fileHash, manifest);
  if (ast.program && ast.program.body) {
    ast.program.body.unshift(...preamble);
  }

  // Write manifest to disk (transform runs in Jest child process — disk is the bridge)
  const manifestDir = process.env.LTR_MANIFEST_DIR;
  if (!manifestDir) {
    _ltrLog('warn', `LTR_MANIFEST_DIR is not set — no coverage for ${sourcePath}`);
  } else {
    const manifestFile = path.join(manifestDir, `${fileHash}.json`);
    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
    } catch (_e) {
      _ltrLog('warn', `could not write coverage manifest ${manifestFile}: ${_e.message}`);
    }
  }

  let output;
  try {
    output = _generate(ast, { retainLines: false, compact: false }, code);
  } catch (e) {
    _ltrLog('debug', `code generation failed for ${sourcePath}: ${e.message}`);
    return null;
  }
  return output.code;
}

// ── Jest transform entry point ───────────────────────────────────────────────

const IS_TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;
/**
 * Single-file components (the extension's sourceFiles.ts list). The batch
 * config only routes them here when the project has a transform for them.
 */
const IS_COMPONENT_RE = /\.(?:vue|svelte|astro|marko)$/i;

/**
 * instrumentAST, but never throws: an instrumentation bug must cost coverage
 * for one file, not make every test file that imports it fail to run.
 */
function safeInstrument(code, sourcePath, lookup) {
  try {
    return instrumentAST(code, sourcePath, lookup);
  } catch (e) {
    _ltrLog('warn', `could not instrument ${sourcePath} (${e.message}) — it runs without coverage/trace`);
    return null;
  }
}

/**
 * Instrumented code + loading the trace runtime first. Jest's ESM mode
 * (`supportsStaticESM`: the file is evaluated as an ES module, where there
 * is no `require`) gets an import instead.
 */
function withRuntime(code, options) {
  if (options && options.supportsStaticESM) {
    return `import ${JSON.stringify(RUNTIME_PATH.replace(/\\/g, '/'))};\n${code}`;
  }
  return `require(${JSON.stringify(RUNTIME_PATH)});\n${code}`;
}

/**
 * A component compiled by the project's transformer → instrumented, with
 * locations moved back to the component through the transformer's map.
 */
function instrumentCompiled(compiled, sourceCode, sourcePath, options) {
  const rootDir = options && options.config && options.config.rootDir;
  if (!compiled) {
    _ltrLog('warn', `no Jest transform compiled ${sourcePath} — it runs without coverage/trace`);
    return { code: sourceCode };
  }
  const lookup = compiled.map ? sourceMapLookup(compiled.map, sourcePath) : null;
  if (!lookup) {
    _ltrLog('debug', `the transform of ${sourcePath} has no source map — it runs without coverage/trace`);
    return { code: compiled.code, map: compiled.map };
  }
  if (rootDir && loadBabel(rootDir)) {
    const instrumented = safeInstrument(compiled.code, sourcePath, lookup);
    if (instrumented) {
      return { code: withRuntime(instrumented, options) };
    }
  }
  return { code: compiled.code, map: compiled.map };
}

module.exports = {
  /** Jest's ESM mode: components may need their transformer's processAsync (svelte-jester, Svelte 4+). */
  async processAsync(sourceCode, sourcePath, options) {
    if (IS_COMPONENT_RE.test(sourcePath) && !IS_TEST_FILE_RE.test(sourcePath)) {
      return instrumentCompiled(await projectTransform(sourceCode, sourcePath, options, true), sourceCode, sourcePath, options);
    }
    return module.exports.process(sourceCode, sourcePath, options);
  },

  process(sourceCode, sourcePath, options) {
    const rootDir = options && options.config && options.config.rootDir;

    // Test and spec files must NOT be instrumented with __covF or __strace.step().
    // The coverage preamble (var __covF = ...) must run before any code that references it,
    // but babel-plugin-jest-hoist moves jest.mock() factories to execute first —
    // BEFORE the preamble — causing "Cannot read properties of undefined" for __covF.
    // Skipping instrumentation for test files keeps them 100% identical to a normal
    // npm-run-test execution. Smart on-save reruns fall back to --findRelatedTests
    // (still correct, just slightly broader scope).
    if (IS_TEST_FILE_RE.test(sourcePath)) {
      const transpiledCode = chainTransform(sourceCode, sourcePath, options);
      return { code: transpiledCode };
    }

    _ltrLog('trace', `instrumenting ${sourcePath}`);

    // Components: the project's transformer (vue-jest, svelte-jester, …)
    // compiles them to JS; that JS is instrumented, with locations moved back
    // to the component through the transformer's source map.
    if (IS_COMPONENT_RE.test(sourcePath)) {
      return instrumentCompiled(projectTransform(sourceCode, sourcePath, options), sourceCode, sourcePath, options);
    }

    // Detect whether the project uses a strict transformer (ts-jest, @swc/jest, etc.)
    // Strict transformers run the real TS compiler and reject our injected globals.
    // For those we must: transpile first (TS→JS) → instrument the clean JS output.
    // Lenient transformers (babel-jest) accept pre-instrumented source, so we keep
    // the existing order: instrument first → transpile.
    let transforms = (options && options.config && options.config.transform) || {};
    if (!Array.isArray(transforms)) {
      transforms = Object.entries(transforms).map(([p, v]) => Array.isArray(v) ? [p, ...v] : [p, v]);
    }
    const matchingEntry = findMatchingTransform(transforms, sourcePath);
    const strict = matchingEntry ? isStrictTransformer(matchingEntry[1]) : false;

    if (rootDir && loadBabel(rootDir)) {
      if (strict) {
        // Transpile first with the project's own transformer, then instrument the JS output.
        const transpiledCode = chainTransform(sourceCode, sourcePath, options);
        const instrumented = safeInstrument(transpiledCode, sourcePath);
        if (instrumented) {
          const finalCode = withRuntime(instrumented, options);
          return { code: finalCode };
        }
        // Instrumentation failed — return at least transpiled code so tests can run
        _ltrLog('warn', `could not instrument ${sourcePath} — it runs without coverage/trace (set log level to Debug for the parse error)`);
        return { code: transpiledCode };
      }

      // Lenient path: instrument first, then transpile (original behaviour)
      const instrumented = safeInstrument(sourceCode, sourcePath);
      if (instrumented) {
        const transpiledCode = chainTransform(instrumented, sourcePath, options);
        const finalCode = withRuntime(transpiledCode, options);
        return { code: finalCode };
      }
    }

    _ltrLog('warn', `could not instrument ${sourcePath} — it runs without coverage/trace (set log level to Debug for the parse error)`);
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
    return { code: transpiledCode };
  },

  // Jest calls this before process() — if the key matches a cached entry the
  // cached output is used directly and process() is never called.
  //
  // Jest 27 signature: (sourceText, sourcePath, configString, options)
  // Jest 28+ signature: (sourceText, sourcePath, options)   ← configString moved into options
  getCacheKey(sourceText, sourcePath, configStringOrOptions, _maybeOptions) {
    const configString = typeof configStringOrOptions === 'string'
      ? configStringOrOptions
      : (configStringOrOptions && configStringOrOptions.configString) || '';
    const options = typeof configStringOrOptions === 'string' ? _maybeOptions : configStringOrOptions;

    return crypto.createHash('sha256')
      .update(sourceText)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(IS_TEST_FILE_RE.test(sourcePath) ? 'test' : 'source')
      .update('\0')
      .update(configString)
      .update('\0')
      .update(options && options.supportsStaticESM ? 'esm' : 'cjs')
      .update('\0')
      .update(getOwnHash())
      .update('\0')
      .update(getRuntimeHash())
      .digest('hex');
  },
};
