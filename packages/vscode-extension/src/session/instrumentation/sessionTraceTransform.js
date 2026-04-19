'use strict';
/**
 * sessionTraceTransform.js — light-trace Jest transform.
 *
 * Instruments source files with:
 *  1. __strace.step(line, file) before each statement — records which lines were hit.
 *  2. __strace.enterTest(name, file) / exitTest() wrapping test callbacks.
 *  3. __strace.enterHook(type, file) / exitHook() wrapping hook callbacks.
 *
 * No variable capture, no parameter capture, no console patching.
 * Uses sessionTraceRuntime.js (light trace).
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'sessionTraceRuntime.js');

// ── Lazy Babel loader ────────────────────────────────────────────────────────

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

// ── Chain through the project's existing transformer ─────────────────────────

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

// ── Main AST instrumentation ─────────────────────────────────────────────────

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

  // Pass 2: inject __strace.step() before each statement (line hit recording only)
  const insertions = [];
  _traverse(ast, {
    Statement: {
      exit(nodePath) {
        const node = nodePath.node;

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

        if (
          t.isIfStatement(node) || t.isForStatement(node) ||
          t.isForInStatement(node) || t.isForOfStatement(node) ||
          t.isWhileStatement(node) || t.isDoWhileStatement(node) ||
          t.isTryStatement(node) || t.isSwitchStatement(node) ||
          t.isLabeledStatement(node)
        ) { return; }

        if (t.isImportDeclaration(node)) { return; }
        if (t.isExportDeclaration(node)) { return; }

        const lineNo = (node.loc && node.loc.start && node.loc.start.line) || 0;
        if (lineNo === 0) { return; }

        insertions.push({ nodePath, stepNode: makeStepCall(lineNo, sourcePath) });
      },
    },
  });

  for (let i = insertions.length - 1; i >= 0; i--) {
    const { nodePath, stepNode } = insertions[i];
    try { nodePath.insertBefore(stepNode); } catch (_e) {}
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
    const rootDir = options && options.config && options.config.rootDir;

    if (rootDir && loadBabel(rootDir)) {
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
