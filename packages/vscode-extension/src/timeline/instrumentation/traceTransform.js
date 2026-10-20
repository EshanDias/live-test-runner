'use strict';
/**
 * traceTransform.js — AST-based Jest transform that injects __trace calls.
 *
 * Implements Jest's synchronous transform interface:
 *   { process(sourceCode, sourcePath, options): { code: string } }
 *
 * Strategy:
 *  1. Parse the original source with @babel/parser (accepts ESM/TS/JSX).
 *  2. Walk the AST with @babel/traverse and inject __trace.step() / __trace.var()
 *     calls after each statement. Import declarations are left untouched so line
 *     numbers stay anchored to the file on disk.
 *  3. Prepend require(traceRuntime.js) so __trace is available at runtime.
 *  4. Chain through the project's existing transformer (babel-jest / ts-jest) to
 *     transpile the instrumented-but-still-ESM code → CommonJS JS.
 *
 * Using an AST (vs regex) means we:
 *  - Never break multi-line expressions, destructuring, JSX, or template literals.
 *  - Correctly handle async/await and generator functions.
 *  - Can reliably convert stray `import` statements so Jest never sees ESM syntax
 *    in a CJS context (fixes "Cannot use import statement outside a module").
 */

const path = require('path');
const RUNTIME_PATH = path.resolve(__dirname, 'traceRuntime.js');

// Log protocol: "[LTR:<level>] msg" lines on stderr are routed by the
// extension's Executor into the "Live Test Runner" log at that level.
const _LTR_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const _ltrMin = _LTR_RANK[process.env.LTR_LOG_LEVEL] ?? _LTR_RANK.info;
function _ltrLog(level, msg) {
  if (_LTR_RANK[level] < _ltrMin) { return; }
  // One line per message so continuation lines don't leak into raw output.
  const text = String(msg).replace(/\s*Require stack:[\s\S]*$/, '').replace(/\s*\r?\n\s*/g, ' ↵ ');
  process.stderr.write(`[LTR:${level}] timeline transform: ${text}\n`);
}

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
    _ltrLog('error', `could not load Babel from ${rootDir} — the timeline will be inaccurate: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chain through the project's existing transformer (same logic as before)
// ---------------------------------------------------------------------------
// Transformers that run the real TypeScript compiler type-check our injected
// globals, so instrumented TS gets ambient declarations for them.
const STRICT_TRANSFORMER_RE = /\bts-jest\b|@swc\/jest\b|\besbuild-jest\b/;

function normalisedTransforms(options) {
  const transforms = (options && options.config && options.config.transform) || {};
  return Array.isArray(transforms)
    ? transforms
    : Object.entries(transforms).map(([p, v]) => (Array.isArray(v) ? [p, ...v] : [p, v]));
}

function findTransform(transforms, sourcePath) {
  return transforms.find(([pattern, moduleName]) => moduleName !== __filename && new RegExp(pattern).test(sourcePath));
}

/** Loads a Jest transformer the way Jest does: `process` directly, or via createTransformer(config). */
function loadTransformer(moduleName, rootDir, transformerConfig) {
  let resolved = moduleName;
  try { resolved = require.resolve(moduleName, { paths: [rootDir, __dirname].filter(Boolean) }); } catch (_) { /* use as given */ }
  const mod = require(resolved);
  if (typeof mod.process === 'function') { return mod; }
  const factory = mod.createTransformer || (mod.default && mod.default.createTransformer);
  if (typeof factory === 'function') { return factory(transformerConfig || {}); }
  if (mod.default && typeof mod.default.process === 'function') { return mod.default; }
  return null;
}

function chainTransform(sourceCode, sourcePath, options) {
  if (!options || !options.config) { return sourceCode; }
  const rootDir = options.config.rootDir;

  const transforms = normalisedTransforms(options);
  _ltrLog('trace', `${transforms.length} transform entr(ies) to chain for ${sourcePath}`);

  const entry = findTransform(transforms, sourcePath);
  if (entry) {
    const [, moduleName, transformerConfig] = entry;
    try {
      const transformer = loadTransformer(moduleName, rootDir, transformerConfig);
      if (transformer) {
        const downstreamOptions = {
          ...options,
          ...(transformerConfig !== undefined ? { transformerConfig } : {}),
          config: { ...options.config, transform: transforms.filter(e => e !== entry) },
        };
        const result = transformer.process(sourceCode, sourcePath, downstreamOptions);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      _ltrLog('warn', `project transformer "${moduleName}" failed on ${sourcePath}: ${_e.message}`);
    }
  }

  // babel-jest fallback (no matching transform entry). Resolved through Node's
  // module lookup — a fixed node_modules/ path breaks under pnpm / Yarn PnP.
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
          const ts = /\.tsx?$/.test(sourcePath) ? tryResolve('@babel/preset-typescript') : null;
          if (env) { presets.push([env, { targets: { node: 'current' } }]); }
          if (react) { presets.push([react, {}]); }
          if (ts) { presets.push([ts, { allExtensions: true, isTSX: /\.tsx$/.test(sourcePath) }]); }
        }
        // No presets found: let babel-jest use the project's own Babel config.
        const transformer = createTransformer(presets.length ? { configFile: false, presets } : {});
        _ltrLog('debug', `babel-jest fallback for ${sourcePath} with presets ${JSON.stringify(presets.map(p => p[0]))}`);
        const result = transformer.process(sourceCode, sourcePath, options);
        if (result && typeof result.code === 'string') { return result.code; }
        if (typeof result === 'string') { return result; }
      }
    } catch (_e) {
      _ltrLog('warn', `babel-jest fallback failed (files run untranspiled): ${_e.message}`);
      _ltrLog('debug', `babel-jest fallback failed on ${sourcePath}`);
    }
  }

  return sourceCode;
}

// ---------------------------------------------------------------------------
// AST instrumentation pass
// ---------------------------------------------------------------------------

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
    _ltrLog('debug', `parse failed for ${sourcePath}: ${e.message}`);
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

        // Never instrument inside jest.mock() / jest.doMock() factory functions —
        // Jest enforces a strict allowlist of variables accessible in those closures
        // and __trace is not on it.
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

        // Leave import declarations for the downstream transpiler (babel-jest/ts-jest)
        // to convert to require() — they carry proper interop helpers we'd lose
        // if we converted them ourselves here.
        if (t.isImportDeclaration(node)) { return; }

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

  let output;
  try {
    output = _generate(ast, { retainLines: false, compact: false }, code);
  } catch (e) {
    _ltrLog('debug', `code generation failed for ${sourcePath}: ${e.message}`);
    return null;
  }

  return output.code;
}

// ---------------------------------------------------------------------------
// Jest transform entry point
// ---------------------------------------------------------------------------
module.exports = {
  process(sourceCode, sourcePath, options) {
    _ltrLog('trace', `instrumenting ${sourcePath}`);
    if (!process.env.TRACE_OUTPUT_FILE) {
      _ltrLog('warn', 'TRACE_OUTPUT_FILE is not set — no timeline steps will be recorded');
    }

    const rootDir = options && options.config && options.config.rootDir;

    // 1. Instrument original source first — line numbers match the file on disk.
    //    Import declarations are left in place; the downstream transpiler handles them.
    if (rootDir && loadBabel(rootDir)) {
      let instrumented = instrumentAST(sourceCode, sourcePath);
      const entry = findTransform(normalisedTransforms(options), sourcePath);
      if (instrumented && entry && STRICT_TRANSFORMER_RE.test(entry[1]) && /\.[cm]?tsx?$/.test(sourcePath)) {
        // ts-jest type-checks: declare the injected globals (erased on compile).
        instrumented = `declare var __trace: any; declare var __currentTestName: any;\n${instrumented}`;
      }
      if (instrumented) {
        // 2. Now transpile the instrumented (still-ESM) code → CJS
        const transpiledCode = chainTransform(instrumented, sourcePath, options);
        // Prepend runtime require to the final CJS output — after transpilation so
        // babel-jest never sees mixed ESM + CJS in the same file.
        const finalCode = `require(${JSON.stringify(RUNTIME_PATH)});\n${transpiledCode}`;
        return { code: finalCode };
      }
      _ltrLog('warn', `AST instrumentation failed for ${sourcePath} — using the regex fallback (line numbers may be off)`);
    }

    // 3. Regex fallback — transpile first then instrument (old order, line numbers
    //    will be wrong but at least the test runs).
    const transpiledCode = chainTransform(sourceCode, sourcePath, options);
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
