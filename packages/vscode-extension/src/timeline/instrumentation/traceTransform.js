'use strict';
/**
 * traceTransform.js — AST-based Jest transform that injects __trace calls.
 *
 * Implements Jest's synchronous transform interface:
 *   { process(sourceCode, sourcePath, options): { code: string } }
 *
 * Strategy:
 *  1. Chain through the project's existing transformer (babel-jest / ts-jest) to
 *     transpile TypeScript / JSX → CommonJS JS first.
 *  2. Parse the CJS output with @babel/parser.
 *  3. Walk the AST with @babel/traverse and inject __trace.step() / __trace.var()
 *     calls after each statement. Any remaining `import` declarations that the
 *     upstream transformer missed are converted to require() calls here.
 *  4. Prepend a require() for traceRuntime.js AFTER all top-level require() calls
 *     so __trace is available before the first traced statement runs.
 *
 * Using an AST (vs regex) means we:
 *  - Never break multi-line expressions, destructuring, JSX, or template literals.
 *  - Correctly handle async/await and generator functions.
 *  - Can reliably convert stray `import` statements so Jest never sees ESM syntax
 *    in a CJS context (fixes "Cannot use import statement outside a module").
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'traceRuntime.js');

// ---------------------------------------------------------------------------
// Lazy-resolve Babel packages from the user's project rootDir so we don't
// need to bundle them inside the extension. Any project using babel-jest has
// @babel/core (and therefore parser/traverse/generator/types) installed.
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
    // These packages sometimes export via .default
    if (_traverse && _traverse.default) { _traverse = _traverse.default; }
    if (_generate && _generate.default) { _generate = _generate.default; }
    _rootDir = rootDir;
    return true;
  } catch (e) {
    process.stderr.write(`[LTR-TRANSFORM] could not load Babel packages from ${rootDir}: ${e.message}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chain through the project's existing transformer (same logic as before)
// ---------------------------------------------------------------------------
function chainTransform(sourceCode, sourcePath, options) {
  if (!options || !options.config) { return sourceCode; }

  let transforms = options.config.transform;
  if (!Array.isArray(transforms)) {
    transforms = Object.entries(transforms || {}).map(([p, v]) =>
      Array.isArray(v) ? [p, ...v] : [p, v],
    );
  }
  process.stderr.write(`[LTR-TRANSFORM] transform chain entries: ${transforms.length}\n`);

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
      process.stderr.write(`[LTR-TRANSFORM] chain transformer error: ${_e.message}\n`);
    }
    break;
  }

  // Babel-jest fallback (CRA / generic projects with no matching transform entry)
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
        process.stderr.write(`[LTR-TRANSFORM] babel-jest fallback with presets: ${JSON.stringify(presets.map(p => p[0]))}\n`);
        const result = transformer.process(sourceCode, sourcePath, options);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      process.stderr.write(`[LTR-TRANSFORM] babel-jest fallback failed: ${_e.message}\n`);
    }
  }

  return sourceCode;
}

// ---------------------------------------------------------------------------
// AST instrumentation pass
// ---------------------------------------------------------------------------

/**
 * Convert a single remaining `import` declaration to a const require() call.
 * e.g.  import foo from './foo'          → const foo = require('./foo').default;
 *       import { a, b } from './lib'     → const { a, b } = require('./lib');
 *       import * as ns from './lib'      → const ns = require('./lib');
 *       import './side-effect'           → require('./side-effect');
 */
function importToRequire(node) {
  const t = _t;
  const src = node.source.value;
  const requireCall = t.callExpression(t.identifier('require'), [t.stringLiteral(src)]);

  const specifiers = node.specifiers || [];
  if (specifiers.length === 0) {
    // Side-effect only import
    return t.expressionStatement(requireCall);
  }

  const defaultSpec  = specifiers.find(s => t.isImportDefaultSpecifier(s));
  const namespaceSpec = specifiers.find(s => t.isImportNamespaceSpecifier(s));
  const namedSpecs   = specifiers.filter(s => t.isImportSpecifier(s));

  if (namespaceSpec) {
    // import * as ns
    return t.variableDeclaration('const', [
      t.variableDeclarator(t.identifier(namespaceSpec.local.name), requireCall),
    ]);
  }

  if (defaultSpec && namedSpecs.length === 0) {
    // import foo from '...'  →  const foo = require('...').default ?? require('...')
    // We use a MemberExpression .default so it works for both CJS and ESM interop.
    return t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier(defaultSpec.local.name),
        t.logicalExpression(
          '??',
          t.memberExpression(requireCall, t.identifier('default')),
          requireCall,
        ),
      ),
    ]);
  }

  if (defaultSpec && namedSpecs.length > 0) {
    // import foo, { a, b } from '...'  →  const _m = require('...'); const foo = _m.default; const { a, b } = _m;
    const tmpId = t.identifier('_ltrMod_' + Math.random().toString(36).slice(2, 7));
    const props = namedSpecs.map(s => {
      const imported = s.imported.name || s.imported.value;
      const local    = s.local.name;
      return imported === local
        ? t.objectProperty(t.identifier(imported), t.identifier(local), false, true)
        : t.objectProperty(t.identifier(imported), t.identifier(local));
    });
    return [
      t.variableDeclaration('const', [t.variableDeclarator(tmpId, requireCall)]),
      t.variableDeclaration('const', [
        t.variableDeclarator(t.identifier(defaultSpec.local.name),
          t.memberExpression(tmpId, t.identifier('default'))),
      ]),
      t.variableDeclaration('const', [
        t.variableDeclarator(t.objectPattern(props), tmpId),
      ]),
    ];
  }

  // Named only: import { a, b } from '...'
  const props = namedSpecs.map(s => {
    const imported = s.imported.name || s.imported.value;
    const local    = s.local.name;
    return imported === local
      ? t.objectProperty(t.identifier(imported), t.identifier(local), false, true)
      : t.objectProperty(t.identifier(imported), t.identifier(local));
  });
  return t.variableDeclaration('const', [
    t.variableDeclarator(t.objectPattern(props), requireCall),
  ]);
}

/**
 * Build a __trace.step() expression statement.
 */
function makeStepCall(stepId, lineNo, filePath) {
  const t = _t;
  return t.expressionStatement(
    t.callExpression(
      t.memberExpression(t.identifier('__trace'), t.identifier('step')),
      [
        t.numericLiteral(stepId),
        t.numericLiteral(lineNo),
        t.stringLiteral(filePath),
        t.conditionalExpression(
          t.binaryExpression(
            '!==',
            t.unaryExpression('typeof', t.identifier('__currentTestName')),
            t.stringLiteral('undefined'),
          ),
          t.identifier('__currentTestName'),
          t.identifier('undefined'),
        ),
      ],
    ),
  );
}

/**
 * Build a __trace.var() expression statement wrapped in try/catch.
 */
function makeVarCall(stepId, varName) {
  const t = _t;
  return t.tryStatement(
    t.blockStatement([
      t.expressionStatement(
        t.callExpression(
          t.memberExpression(t.identifier('__trace'), t.identifier('var')),
          [t.numericLiteral(stepId), t.stringLiteral(varName), t.identifier(varName)],
        ),
      ),
    ]),
    t.catchClause(t.identifier('_ltrE'), t.blockStatement([])),
  );
}

/**
 * Walk the AST and inject trace calls. Returns the instrumented code string.
 */
function instrumentAST(code, sourcePath) {
  const t = _t;
  let ast;
  try {
    ast = _parser.parse(code, {
      sourceType: 'module',   // accept both CJS and ESM syntax
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
    });
  } catch (e) {
    process.stderr.write(`[LTR-TRANSFORM] AST parse failed: ${e.message}\n`);
    return null;
  }

  let stepId = 0;
  // Collect new nodes to insert: { path, nodes[] } after each visited statement
  const insertions = [];

  _traverse(ast, {
    Statement: {
      exit(nodePath) {
        // Skip nodes we shouldn't instrument
        const node = nodePath.node;

        // Only instrument direct children of the Program or a block body —
        // not the body of if/for/while themselves (we instrument the inner statements).
        // Skip container nodes whose bodies we'll walk into.
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
        ) {
          return;
        }

        // Convert remaining import declarations to require() calls
        if (t.isImportDeclaration(node)) {
          const replacement = importToRequire(node);
          if (Array.isArray(replacement)) {
            nodePath.replaceWithMultiple(replacement);
          } else {
            nodePath.replaceWith(replacement);
          }
          return;
        }

        // Skip export declarations (those are for source files, not test files,
        // but handle gracefully just in case)
        if (t.isExportDeclaration(node)) { return; }

        const lineNo = (node.loc && node.loc.start && node.loc.start.line) || 0;
        stepId++;
        const sid = stepId;

        const toInsert = [makeStepCall(sid, lineNo, sourcePath)];

        // Variable capture for declarations and assignments
        if (t.isVariableDeclaration(node)) {
          for (const decl of node.declarations) {
            if (t.isIdentifier(decl.id)) {
              toInsert.push(makeVarCall(sid, decl.id.name));
            }
          }
        } else if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression)) {
          const left = node.expression.left;
          if (t.isIdentifier(left)) {
            toInsert.push(makeVarCall(sid, left.name));
          }
        }

        insertions.push({ nodePath, nodes: toInsert });
      },
    },
  });

  // Insert in reverse order so that earlier insertions don't shift indices
  for (let i = insertions.length - 1; i >= 0; i--) {
    const { nodePath, nodes } = insertions[i];
    try {
      nodePath.insertAfter(nodes.slice().reverse());
    } catch (_e) {
      // Skip if the path is no longer valid (e.g. already replaced)
    }
  }

  // Prepend runtime require at the very top of the program
  const runtimeRequire = t.expressionStatement(
    t.callExpression(t.identifier('require'), [t.stringLiteral(RUNTIME_PATH)]),
  );
  ast.program.body.unshift(runtimeRequire);

  let output;
  try {
    output = _generate(ast, { retainLines: false, compact: false }, code);
  } catch (e) {
    process.stderr.write(`[LTR-TRANSFORM] AST generate failed: ${e.message}\n`);
    return null;
  }

  return output.code;
}

// ---------------------------------------------------------------------------
// Jest transform entry point
// ---------------------------------------------------------------------------
module.exports = {
  process(sourceCode, sourcePath, options) {
    process.stderr.write(`[LTR-TRANSFORM] called for: ${sourcePath}\n`);
    process.stderr.write(`[LTR-TRANSFORM] TRACE_OUTPUT_FILE: ${process.env.TRACE_OUTPUT_FILE || '(not set)'}\n`);

    // 1. Chain through project's transformer (babel-jest / ts-jest) → CJS JS
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
    process.stderr.write(`[LTR-TRANSFORM] chain result length: ${transpiledCode.length}\n`);

    // 2. Try AST instrumentation
    const rootDir = options && options.config && options.config.rootDir;
    if (rootDir && loadBabel(rootDir)) {
      const instrumented = instrumentAST(transpiledCode, sourcePath);
      if (instrumented) {
        process.stderr.write(`[LTR-TRANSFORM] AST instrumentation succeeded\n`);
        return { code: instrumented };
      }
      process.stderr.write(`[LTR-TRANSFORM] AST instrumentation failed, falling back to regex\n`);
    }

    // 3. Regex fallback (original behaviour) if AST is unavailable
    const lines = transpiledCode.split('\n');
    const outLines = [];
    let stepId = 0;
    let depth = 0;

    const SKIP_LINE  = /^\s*(\/\/|\/\*|\*|'use strict'|"use strict"|import\s|export\s)/;
    const ASSIGN_VAR = /^\s*(?:const|let|var)\s+(\w+)\s*=/;
    const REASSIGN   = /^\s*(\w+)\s*(?:[+\-*/%&|^]=|=)(?!=)/;

    outLines.push(`require(${JSON.stringify(RUNTIME_PATH)});`);

    for (let i = 0; i < lines.length; i++) {
      const raw  = lines[i];
      const trim = raw.trim();
      outLines.push(raw);

      for (const ch of raw) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; }
        else if (ch === '}' || ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); }
      }

      if (depth > 0 || !trim || SKIP_LINE.test(trim)) { continue; }

      stepId++;
      const lineNo = i + 1;
      outLines.push(
        `__trace.step(${stepId}, ${lineNo}, ${JSON.stringify(sourcePath)}, ` +
        `(typeof __currentTestName !== 'undefined' ? __currentTestName : undefined));`,
      );

      let varName = null;
      const constMatch = ASSIGN_VAR.exec(trim);
      if (constMatch) {
        varName = constMatch[1];
      } else {
        const reassignMatch = REASSIGN.exec(trim);
        if (reassignMatch) { varName = reassignMatch[1]; }
      }

      if (varName) {
        outLines.push(
          `try { __trace.var(${stepId}, ${JSON.stringify(varName)}, ${varName}); } catch(_e) {}`,
        );
      }
    }

    return { code: outLines.join('\n') };
  },
};
