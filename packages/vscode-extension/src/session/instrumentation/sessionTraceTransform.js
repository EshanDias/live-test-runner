'use strict';
/**
 * sessionTraceTransform.js — AST-based Jest transform for full-session tracing.
 *
 * Distinct from traceTransform.js (used by the Timeline Debugger). This transform:
 *  1. Injects __strace.step() / __strace.var() before each statement (same as traceTransform).
 *  2. Additionally wraps it/test/beforeAll/beforeEach/afterEach/afterAll callback
 *     bodies with __strace.enterTest()/exitTest() or __strace.enterHook()/exitHook()
 *     so the runtime knows which test each step belongs to.
 *  3. Uses sessionTraceRuntime.js instead of traceRuntime.js.
 *
 * Output format (written to SESSION_TRACE_FILE by the runtime):
 *   One JSON line per STEP/VAR/LOG, each carrying { context, testName }.
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'sessionTraceRuntime.js');

// ---------------------------------------------------------------------------
// Lazy Babel loader (same pattern as traceTransform.js)
// ---------------------------------------------------------------------------
let _rootDir = null;
let _parser, _traverse, _generate, _t;

function loadBabel(rootDir) {
  if (_rootDir === rootDir && _parser) { return true; }
  try {
    const resolve = (id) => require.resolve(id, { paths: [rootDir, __dirname] });
    _parser   = require(resolve('@babel/parser'));
    _traverse = require(resolve('@babel/traverse'));
    _generate = require(resolve('@babel/generator'));
    _t        = require(resolve('@babel/types'));
    if (_traverse && _traverse.default) { _traverse = _traverse.default; }
    if (_generate && _generate.default) { _generate = _generate.default; }
    _rootDir = rootDir;
    return true;
  } catch (e) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] could not load Babel: ${e.message}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chain through project's existing transformer (same as traceTransform.js)
// ---------------------------------------------------------------------------
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
      const transformer = require(moduleName);
      if (typeof transformer.process !== 'function') { continue; }
      const downstreamOptions = {
        ...options,
        config: { ...options.config, transform: transforms.filter(e => e !== entry) },
      };
      const result = transformer.process(sourceCode, sourcePath, downstreamOptions);
      if (result && typeof result.code === 'string') { return result.code; }
      if (typeof result === 'string') { return result; }
    } catch (_e) {
      process.stderr.write(`[LTR-SESSION-TRANSFORM] chain error: ${_e.message}\n`);
    }
    break;
  }

  // babel-jest fallback for CRA / projects with no transform entry
  const rootDir = options && options.config && options.config.rootDir;
  if (rootDir) {
    const babelJestPath = path.join(rootDir, 'node_modules', 'babel-jest');
    try {
      const babelJest = require(babelJestPath);
      const createTransformer = babelJest.createTransformer
        || (babelJest.default && babelJest.default.createTransformer);
      if (createTransformer) {
        let presets;
        const reactAppPreset = path.join(rootDir, 'node_modules', 'babel-preset-react-app');
        const presetEnv      = path.join(rootDir, 'node_modules', '@babel', 'preset-env');
        const presetReact    = path.join(rootDir, 'node_modules', '@babel', 'preset-react');
        try {
          require(reactAppPreset);
          presets = [[reactAppPreset, { runtime: 'automatic' }]];
        } catch (_) {
          const ps = [[presetEnv, { targets: { node: 'current' } }]];
          try { require(presetReact); ps.push([presetReact, {}]); } catch (_) {}
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

// ---------------------------------------------------------------------------
// Helpers to build AST nodes
// ---------------------------------------------------------------------------

/** __strace.step(line, file) */
function makeStepCall(lineNo, filePath) {
  const t = _t;
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__strace'), t.identifier('step')),
      [t.numericLiteral(lineNo), t.stringLiteral(filePath)],
    ),
  );
}

/** try { __strace.var(line, file, name, value) } catch(_e) {} */
function makeVarCall(lineNo, filePath, varName) {
  const t = _t;
  return t.tryStatement(
    t.blockStatement([
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier('__strace'), t.identifier('var')),
          [t.numericLiteral(lineNo), t.stringLiteral(filePath), t.stringLiteral(varName), t.identifier(varName)],
        ),
      ),
    ]),
    t.catchClause(t.identifier('_ltrE'), t.blockStatement([])),
  );
}

/**
 * Wrap a function body (BlockStatement) with enter/exit calls.
 *
 * For tests:   __strace.enterTest(testName) at top, __strace.exitTest() in finally
 * For hooks:   __strace.enterHook('beforeEach') at top, __strace.exitHook() in finally
 *
 * Using try/finally ensures exitTest/exitHook fires even if the test throws.
 */
function wrapBodyWithContext(bodyNode, enterCall, exitCall) {
  const t = _t;
  // Wrap original body in try/finally so the exit always fires
  const wrapped = t.tryStatement(
    t.blockStatement(bodyNode.body),
    null,
    t.blockStatement([t.expressionStatement(exitCall)]),
  );
  bodyNode.body = [t.expressionStatement(enterCall), wrapped];
}

/** Build __strace.enterTest(nameStringLiteral) */
function makeEnterTest(name) {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('enterTest')),
    [_t.stringLiteral(name)],
  );
}

/** Build __strace.exitTest() */
function makeExitTest() {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('exitTest')),
    [],
  );
}

/** Build __strace.enterHook(hookType) */
function makeEnterHook(hookType) {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('enterHook')),
    [_t.stringLiteral(hookType)],
  );
}

/** Build __strace.exitHook() */
function makeExitHook() {
  return _t.callExpression(
    _t.memberExpression(_t.identifier('__strace'), _t.identifier('exitHook')),
    [],
  );
}

// ---------------------------------------------------------------------------
// Detect Jest test/hook call names
// ---------------------------------------------------------------------------
const HOOK_NAMES     = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll']);
const TEST_NAMES     = new Set(['it', 'test']);
const DESCRIBE_NAMES = new Set(['describe']);

/**
 * If the node is a Jest test/hook call, return { kind: 'test'|'hook', name }.
 * Handles: it(...), test(...), beforeAll(...), it.only(...), it.each(...)(...), etc.
 * Returns null if not a recognised Jest call.
 */
function classifyCall(node) {
  const t = _t;
  let callee = node.callee;

  // Unwrap member expressions like it.only, test.skip, it.each(...)
  // We walk until we find an Identifier at the base.
  let baseName = null;
  if (t.isIdentifier(callee)) {
    baseName = callee.name;
  } else if (t.isMemberExpression(callee)) {
    // it.only / test.skip / describe.each(...)(...) etc.
    let obj = callee;
    while (t.isMemberExpression(obj)) { obj = obj.object; }
    if (t.isIdentifier(obj)) { baseName = obj.name; }
  } else if (t.isCallExpression(callee)) {
    // it.each([...])(name, fn) — curried form
    let inner = callee.callee;
    while (t.isMemberExpression(inner)) { inner = inner.object; }
    if (t.isIdentifier(inner)) { baseName = inner.name; }
  }

  if (!baseName) { return null; }

  if (TEST_NAMES.has(baseName)) {
    // First arg is the test name (may be a string literal or template literal)
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

  if (HOOK_NAMES.has(baseName)) {
    return { kind: 'hook', name: baseName };
  }

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

/**
 * Find the function argument (the callback) from a Jest call's argument list.
 * Handles: it('name', fn), it('name', fn, timeout), it.each(...)('name', fn).
 * The callback is the first FunctionExpression or ArrowFunctionExpression argument.
 */
function findCallbackArg(args) {
  for (const arg of args) {
    if (_t.isFunctionExpression(arg) || _t.isArrowFunctionExpression(arg)) {
      return arg;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main AST instrumentation pass
// ---------------------------------------------------------------------------
function instrumentAST(code, sourcePath) {
  const t = _t;
  let ast;
  try {
    ast = _parser.parse(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
    });
  } catch (e) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] AST parse failed for ${sourcePath}: ${e.message}\n`);
    return null;
  }

  const insertions = [];  // { nodePath, nodes[] } — statements to insert after each step

  // Pass 1: inject context wrappers around test/hook callbacks.
  // Track describe nesting so tests emit their full name (matching Jest's fullName field).
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
          wrapBodyWithContext(cb.body, makeEnterTest(fullName), makeExitTest());
        } else if (info.kind === 'hook') {
          wrapBodyWithContext(cb.body, makeEnterHook(info.name), makeExitHook());
        }
      },
      exit(nodePath) {
        const info = classifyCall(nodePath.node);
        if (info?.kind === 'describe') { describeStack.pop(); }
      },
    },
  });

  // Pass 2: inject __strace.step() / __strace.var() before each statement
  _traverse(ast, {
    Statement: {
      exit(nodePath) {
        const node = nodePath.node;

        // Never instrument inside jest.mock() factories
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

        // Skip container nodes — we instrument their inner statements instead
        if (
          t.isIfStatement(node) ||
          t.isForStatement(node) ||
          t.isForInStatement(node) ||
          t.isForOfStatement(node) ||
          t.isWhileStatement(node) ||
          t.isDoWhileStatement(node) ||
          t.isTryStatement(node) ||
          t.isSwitchStatement(node) ||
          t.isLabeledStatement(node)
        ) { return; }

        if (t.isImportDeclaration(node)) { return; }
        if (t.isExportDeclaration(node)) { return; }

        const lineNo = (node.loc && node.loc.start && node.loc.start.line) || 0;
        if (lineNo === 0) { return; } // synthetic node injected by transform — no source location
        const stepNode = makeStepCall(lineNo, sourcePath);

        // Variable capture (inserted after the statement so the variable is assigned)
        const varNodes = [];
        if (t.isVariableDeclaration(node)) {
          for (const decl of node.declarations) {
            if (t.isIdentifier(decl.id)) {
              varNodes.push(makeVarCall(lineNo, sourcePath, decl.id.name));
            }
          }
        } else if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
          const left = node.expression.left;
          if (t.isIdentifier(left)) {
            varNodes.push(makeVarCall(lineNo, sourcePath, left.name));
          }
        }

        insertions.push({ nodePath, stepNode, varNodes });
      },
    },
  });

  // Apply insertions in reverse order to preserve indices.
  // STEP is inserted BEFORE the statement so it fires before any called functions log their steps.
  // VAR is inserted AFTER so the variable is already assigned when captured.
  for (let i = insertions.length - 1; i >= 0; i--) {
    const { nodePath, stepNode, varNodes } = insertions[i];
    try {
      if (varNodes.length > 0) {
        // insertAfter with multiple nodes: pass reversed so they appear in declaration order
        nodePath.insertAfter(varNodes.slice().reverse());
      }
      nodePath.insertBefore(stepNode);
    } catch (_e) {
      // skip invalid paths
    }
  }

  // Pass 3: inject param captures at the top of every function body.
  // Runs after Pass 2 so these injected TryStatement nodes are not themselves re-instrumented.
  _traverse(ast, {
    'FunctionDeclaration|FunctionExpression|ArrowFunctionExpression'(nodePath) {
      const node = nodePath.node;
      // Concise arrow (x => x+1) has no BlockStatement body — skip
      if (!t.isBlockStatement(node.body)) { return; }

      // Skip jest.mock / jest.doMock factory functions
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

      const params = node.params;
      if (!params.length) { return; }

      const lineNo = (node.loc && node.loc.start && node.loc.start.line) || 0;
      const varCalls = [];
      for (const param of params) {
        if (t.isIdentifier(param)) {
          varCalls.push(makeVarCall(lineNo, sourcePath, param.name));
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
          // default param: function foo(x = 5)
          varCalls.push(makeVarCall(lineNo, sourcePath, param.left.name));
        } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
          // rest param: function foo(...args)
          varCalls.push(makeVarCall(lineNo, sourcePath, param.argument.name));
        }
      }

      if (varCalls.length) {
        // Prepend to the function body so params are captured before any step runs
        node.body.body.unshift(...varCalls);
      }
    },
  });

  let output;
  try {
    output = _generate(ast, { retainLines: false, compact: false }, code);
  } catch (e) {
    process.stderr.write(`[LTR-SESSION-TRANSFORM] generate failed: ${e.message}\n`);
    return null;
  }

  return output.code;
}

// ---------------------------------------------------------------------------
// Jest transform entry point
// ---------------------------------------------------------------------------
module.exports = {
  process(sourceCode, sourcePath, options) {
    const rootDir = options && options.config && options.config.rootDir;

    if (rootDir && loadBabel(rootDir)) {
      const instrumented = instrumentAST(sourceCode, sourcePath);
      if (instrumented) {
        const transpiledCode = chainTransform(instrumented, sourcePath, options);
        const finalCode = `require(${JSON.stringify(RUNTIME_PATH)});\n${transpiledCode}`;
        return { code: finalCode };
      }
    }

    // Fallback: transpile without instrumentation rather than breaking the run
    process.stderr.write(`[LTR-SESSION-TRANSFORM] instrumentation failed for ${sourcePath}, running uninstrumented\n`);
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
    return { code: transpiledCode };
  },
};
