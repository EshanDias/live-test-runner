'use strict';
process.stderr.write('[LTR-SESSION-TRANSFORM] module loaded\n');
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
const RUNTIME_PATH = path.resolve(__dirname, 'sessionTraceRuntime.js');

function _fileHash(filePath) {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
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
    process.stderr.write(`[LTR][Coverage] loadBabel: FAILED to load Babel for rootDir="${rootDir}" — ${e.message}\n`);
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

function invokeTransformer(moduleName, sourceCode, sourcePath, options, transforms) {
  // Resolve from the project root first so ts-jest / @swc/jest / etc. are found
  // in the project's node_modules even though they are not in the extension's.
  const rootDir = options && options.config && options.config.rootDir;
  let resolvedPath = moduleName;
  try {
    resolvedPath = require.resolve(moduleName, { paths: [rootDir, __dirname].filter(Boolean) });
  } catch (resolveErr) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] resolve failed for ${moduleName}: ${resolveErr.message}\n`);
  }
  // Extract per-transformer config (index 2 of the transform entry, e.g. { tsconfig: '...' }).
  // Jest passes this as options.transformerConfig — ts-jest, @swc/jest etc. read it from there.
  const entry = transforms.find(e => e[1] === moduleName);
  const transformerConfig = (entry && entry[2]) || undefined;

  let transformer;
  try {
    const mod = require(resolvedPath);
    // Some transformers (ts-jest v28+) don't export process directly.
    // They expose a createTransformer factory on the default export.
    if (typeof mod.process === 'function') {
      transformer = mod;
    } else if (mod.default && typeof mod.default.createTransformer === 'function') {
      transformer = mod.default.createTransformer(transformerConfig || {});
    } else if (typeof mod.createTransformer === 'function') {
      transformer = mod.createTransformer(transformerConfig || {});
    }
  } catch (requireErr) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] require failed for ${resolvedPath}: ${requireErr.message}\n`);
    return null;
  }
  if (!transformer || typeof transformer.process !== 'function') { return null; }

  const downstreamOptions = {
    ...options,
    ...(transformerConfig !== undefined ? { transformerConfig } : {}),
    config: { ...options.config, transform: transforms.filter(e => e[1] !== moduleName) },
  };
  const result = transformer.process(sourceCode, sourcePath, downstreamOptions);
  if (result && typeof result.code === 'string') { return result.code; }
  if (typeof result === 'string') { return result; }
  return null;
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
      if (result !== null) { return result; }
    } catch (_e) {
      process.stderr.write(`[LTR-SESSION-TRANSFORM] chain error: ${_e.message}\n`);
    }
    break;
  }

  // babel-jest fallback for CRA / projects with no matching transform entry
  const rootDir = options && options.config && options.config.rootDir;
  if (rootDir) {
    const babelJestPath = path.join(rootDir, 'node_modules', 'babel-jest');
    try {
      const babelJest = require(babelJestPath);
      const createTransformer = babelJest.createTransformer
        || (babelJest.default && babelJest.default.createTransformer);
      if (createTransformer) {
        let presets;
        const reactAppPreset   = path.join(rootDir, 'node_modules', 'babel-preset-react-app');
        const presetEnv        = path.join(rootDir, 'node_modules', '@babel', 'preset-env');
        const presetReact      = path.join(rootDir, 'node_modules', '@babel', 'preset-react');
        const presetTypescript = path.join(rootDir, 'node_modules', '@babel', 'preset-typescript');
        const isTs = /\.(ts|tsx)$/.test(sourcePath);
        try {
          require(reactAppPreset);
          presets = [[reactAppPreset, { runtime: 'automatic' }]];
        } catch (_) {
          const ps = [[presetEnv, { targets: { node: 'current' } }]];
          try { require(presetReact); ps.push([presetReact, {}]); } catch (_) {}
          if (isTs) {
            try { require(presetTypescript); ps.push([presetTypescript, { allExtensions: true, isTSX: /\.tsx$/.test(sourcePath) }]); } catch (_) {}
          }
          presets = ps;
        }
        const transformer = createTransformer({ configFile: false, presets });
        const result = transformer.process(sourceCode, sourcePath, options);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      process.stderr.write(`[LTR-SESSION-TRANSFORM] babel-jest fallback failed: ${_e.message}\n`);
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

function instrumentAST(code, sourcePath) {
  const t = _t;
  let ast;
  try {
    ast = _parser.parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (e) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] AST parse failed for ${sourcePath}: ${e.message}\n`);
    return null;
  }

  // Coverage manifest — built during the walk below
  const fileHash = _fileHash(sourcePath);
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
        const bId  = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'cond-expr', line: node.loc?.start?.line ?? 0, arms: 2 };
        node.consequent = t.sequenceExpression([makeCovBranchExpr(bId, 0), node.consequent]);
        node.alternate  = t.sequenceExpression([makeCovBranchExpr(bId, 1), node.alternate]);
      },
    },

    // Branch coverage — optional chaining (?.)
    // Each `?.` is a 2-arm branch: arm 0 = non-null path, arm 1 = short-circuit (null/undefined).
    // For identifier objects we can use them directly. For complex expressions we inject a
    // temp var via a sequence assignment so the object is only evaluated once.
    //
    // IMPORTANT: `obj?.method(args)` in Babel is:
    //   OptionalCallExpression { callee: OptionalMemberExpression(obj, method, optional:true), optional: false }
    // We must include the call args in the non-null branch, otherwise when obj is null our
    // ternary returns `undefined` and the outer call becomes `undefined(args)` → TypeError.
    OptionalMemberExpression: {
      exit(nodePath) {
        const node = nodePath.node;
        if (!node.optional) { return; } // chained `.` after a `?.` — not a new branch point
        const bId = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'optional-chaining', line: node.loc?.start?.line ?? 0, arms: 2 };

        const obj = node.object;
        let objForCheck, objForUse;
        if (t.isIdentifier(obj)) {
          objForCheck = obj;
          objForUse   = t.identifier(obj.name);
        } else {
          const tmpName = `_ltrOc${bIdx}`;
          tempVarNames.push(tmpName);
          objForCheck = t.assignmentExpression('=', t.identifier(tmpName), obj);
          objForUse   = t.identifier(tmpName);
        }

        // If parent is `OptionalCallExpression { optional: false }` (i.e. `obj?.method(args)`),
        // pull the call args into the non-null branch so we never call `undefined(args)`.
        const parentPath = nodePath.parentPath;
        const parentNode = parentPath?.node;
        if (parentNode?.type === 'OptionalCallExpression' && !parentNode.optional &&
            parentNode.callee === node) {
          const replacement = t.conditionalExpression(
            t.binaryExpression('==', objForCheck, t.nullLiteral()),
            t.sequenceExpression([makeCovBranchExpr(bId, 1), t.identifier('undefined')]),
            t.sequenceExpression([
              makeCovBranchExpr(bId, 0),
              t.callExpression(t.memberExpression(objForUse, node.property, node.computed), parentNode.arguments),
            ]),
          );
          generatedCondExprs.add(replacement);
          parentPath.replaceWith(replacement); // replace the whole call, not just the member
        } else {
          const replacement = t.conditionalExpression(
            t.binaryExpression('==', objForCheck, t.nullLiteral()),
            t.sequenceExpression([makeCovBranchExpr(bId, 1), t.identifier('undefined')]),
            t.sequenceExpression([makeCovBranchExpr(bId, 0), t.memberExpression(objForUse, node.property, node.computed)]),
          );
          generatedCondExprs.add(replacement);
          nodePath.replaceWith(replacement);
        }
      },
    },

    // Branch coverage — optional call expressions (fn?.())
    OptionalCallExpression: {
      exit(nodePath) {
        const node = nodePath.node;
        if (!node.optional) { return; }
        const bId = `b${bIdx++}`;
        manifest.branches[bId] = { type: 'optional-chaining', line: node.loc?.start?.line ?? 0, arms: 2 };

        const callee = node.callee;
        let calleeForCheck, calleeForUse;
        if (t.isIdentifier(callee)) {
          calleeForCheck = callee;
          calleeForUse   = t.identifier(callee.name);
        } else {
          const tmpName = `_ltrOc${bIdx}`;
          tempVarNames.push(tmpName);
          calleeForCheck = t.assignmentExpression('=', t.identifier(tmpName), callee);
          calleeForUse   = t.identifier(tmpName);
        }
        const replacement = t.conditionalExpression(
          t.binaryExpression('==', calleeForCheck, t.nullLiteral()),
          t.sequenceExpression([makeCovBranchExpr(bId, 1), t.identifier('undefined')]),
          t.sequenceExpression([makeCovBranchExpr(bId, 0), t.callExpression(calleeForUse, node.arguments)]),
        );
        generatedCondExprs.add(replacement);
        nodePath.replaceWith(replacement);
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
      if (!cases.length) { return; }
      const bId = `b${bIdx++}`;
      manifest.branches[bId] = { type: 'switch', line: node.loc?.start?.line ?? 0, arms: cases.length };
      cases.forEach((switchCase, armIdx) => {
        switchCase.consequent.unshift(makeCovBranch(bId, armIdx));
      });
    },

    // Branch coverage — if/else
    IfStatement(nodePath) {
      const node = nodePath.node;
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
    process.stderr.write(`[LTR][Coverage] manifest: LTR_MANIFEST_DIR env not set — manifest will not be written for "${sourcePath}"\n`);
  } else {
    const manifestFile = path.join(manifestDir, `${fileHash}.json`);
    try {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
    } catch (_e) {
      process.stderr.write(`[LTR][Coverage] manifest: FAILED to write "${manifestFile}" — ${_e.message}\n`);
    }
  }

  let output;
  try {
    output = _generate(ast, { retainLines: false, compact: false }, code);
  } catch (e) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] generate failed: ${e.message}\n`);
    return null;
  }
  return output.code;
}

// ── Jest transform entry point ───────────────────────────────────────────────

module.exports = {
  process(sourceCode, sourcePath, options) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] process() called for: ${sourcePath}\n`);
    const rootDir = options && options.config && options.config.rootDir;

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
        const instrumented = instrumentAST(transpiledCode, sourcePath);
        if (instrumented) {
          const finalCode = `require(${JSON.stringify(RUNTIME_PATH)});\n${instrumented}`;
          return { code: finalCode };
        }
        // Instrumentation failed — return at least transpiled code so tests can run
        process.stderr.write(`[LTR-SESSION-TRANSFORM] instrumentation failed for ${sourcePath}, running uninstrumented\n`);
        return { code: transpiledCode };
      }

      // Lenient path: instrument first, then transpile (original behaviour)
      const instrumented = instrumentAST(sourceCode, sourcePath);
      if (instrumented) {
        const transpiledCode = chainTransform(instrumented, sourcePath, options);
        const finalCode = `require(${JSON.stringify(RUNTIME_PATH)});\n${transpiledCode}`;
        return { code: finalCode };
      }
    }

    process.stderr.write(`[LTR-SESSION-TRANSFORM] instrumentation failed for ${sourcePath}, running uninstrumented\n`);
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
    return { code: transpiledCode };
  },
};
