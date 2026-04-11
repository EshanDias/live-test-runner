'use strict';

/**
 * testDiscovery.js — Static AST-based test structure extractor.
 *
 * Parses a test file and returns the full describe/it/test tree with
 * 1-based line numbers for each node. No code is executed or injected —
 * this is a read-only analysis pass.
 *
 * Reuses the same lazy Babel loader as traceTransform.js so we don't need
 * to bundle Babel inside the extension.
 *
 * @example
 *   const { discoverTests } = require('./testDiscovery');
 *   const result = discoverTests(sourceCode, filePath, projectRoot);
 *   // => { suites: [{ name, line, tests: [{ name, line, fullName }] }],
 *   //      rootTests: [{ name, line, fullName }] }
 */

let _rootDir = null;
let _parser, _traverse;

function loadBabel(rootDir) {
  if (_rootDir === rootDir && _parser) { return true; }
  try {
    const resolve = (id) => require.resolve(id, { paths: [rootDir, __dirname] });
    _parser   = require(resolve('@babel/parser'));
    _traverse = require(resolve('@babel/traverse'));
    if (_traverse && _traverse.default) { _traverse = _traverse.default; }
    _rootDir = rootDir;
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a static string from a node.
 *
 * - StringLiteral: exact value.
 * - TemplateLiteral with no expressions: exact value.
 * - TemplateLiteral with expressions: returns the static prefix + "…" so the
 *   test still appears in the tree even though the full name is dynamic.
 *   e.g. `accepts valid severity ${s}` → "accepts valid severity …"
 * - Everything else (computed variable, call expression, etc.): null.
 */
function getStringValue(node) {
  if (!node) { return null; }
  if (node.type === 'StringLiteral') { return node.value; }
  if (node.type === 'TemplateLiteral') {
    // No expressions: `plain string`
    if (node.quasis.length === 1) { return node.quasis[0].value.cooked ?? ''; }
    // Has expressions: reconstruct as a readable pattern with … placeholders.
    // e.g. `accepts ${s}`  →  "accepts …"
    //      `${s}`          →  "…"
    //      `${a}: ${b}`    →  "…: …"
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      const text = node.quasis[i].value.cooked ?? '';
      if (text) { parts.push(text); }
      if (i < node.expressions.length) { parts.push('…'); }
    }
    const result = parts.join('').trim();
    return result.length > 0 ? result : '…';   // always return something
  }
  return null;
}

/**
 * Returns 'describe' | 'test' | null for a CallExpression node.
 *
 * Handles all common Jest calling patterns:
 *   describe(name, fn)                       — Identifier
 *   describe.only/skip/each(name, fn)        — MemberExpression depth 1
 *   it.concurrent.each([...])(name, fn)      — MemberExpression depth 2
 *   test.each([...])(name, fn)               — callee is itself a CallExpression (.each)
 */
function getCallType(node) {
  if (node.type !== 'CallExpression') { return null; }
  const callee = node.callee;

  // ── Plain call: describe(...) / it(...) / test(...) ──────────────────────
  if (callee.type === 'Identifier') {
    if (callee.name === 'describe') { return 'describe'; }
    if (callee.name === 'it' || callee.name === 'test') { return 'test'; }
    return null;
  }

  // ── Member call: describe.only / it.skip / test.each / it.concurrent ─────
  if (callee.type === 'MemberExpression') {
    const root = _memberRoot(callee); // walk to the leftmost Identifier
    if (root === 'describe') { return 'describe'; }
    if (root === 'it' || root === 'test') { return 'test'; }
    return null;
  }

  // ── Curried .each: test.each([...])(name, fn)  ────────────────────────────
  // The outer call's callee is itself a CallExpression (the test.each([...]) part).
  if (callee.type === 'CallExpression') {
    const inner = callee.callee;
    if (inner.type === 'MemberExpression') {
      const root = _memberRoot(inner);
      const prop = _memberLeaf(inner);
      if (prop === 'each') {
        if (root === 'describe') { return 'describe'; }
        if (root === 'it' || root === 'test') { return 'test'; }
      }
    }
  }

  return null;
}

/**
 * Walk a MemberExpression chain leftward and return the root Identifier name.
 * e.g. it.concurrent.each  →  'it'
 */
function _memberRoot(memberExpr) {
  let node = memberExpr;
  while (node.type === 'MemberExpression') { node = node.object; }
  return node.type === 'Identifier' ? node.name : null;
}

/**
 * Return the rightmost property name of a MemberExpression chain.
 * e.g. it.concurrent.each  →  'each'
 */
function _memberLeaf(memberExpr) {
  return memberExpr.property.type === 'Identifier' ? memberExpr.property.name : null;
}

// ---------------------------------------------------------------------------
// Shared variable detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the node is a primitive literal (immutable — cannot be
 * mutated by another test). const declarations of these are safe.
 */
function _isPrimitiveLiteral(node) {
  return (
    node.type === 'NumericLiteral' ||
    node.type === 'StringLiteral' ||
    node.type === 'BooleanLiteral' ||
    node.type === 'NullLiteral' ||
    (node.type === 'TemplateLiteral' && node.expressions.length === 0)
  );
}

/**
 * Recursively walk an AST subtree and return true if an Identifier with
 * the given name is referenced anywhere inside it.
 * Does NOT descend into nested function scopes that shadow the name.
 */
function _containsRef(node, name, depth) {
  if (!node || typeof node !== 'object') { return false; }
  if (depth > 80) { return false; } // guard against extremely deep trees

  if (node.type === 'Identifier' && node.name === name) { return true; }

  // Don't descend into a function that re-declares the same name as a parameter
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    const params = node.params || [];
    for (const p of params) {
      if (p.type === 'Identifier' && p.name === name) { return false; }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') { continue; }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (_containsRef(item, name, depth + 1)) { return true; }
      }
    } else if (child && typeof child === 'object' && child.type) {
      if (_containsRef(child, name, depth + 1)) { return true; }
    }
  }
  return false;
}

/**
 * Collect the names of mutable variables declared at the DIRECT top level of
 * a block statement body (not inside nested blocks, functions, or it/test calls).
 *
 * Rules:
 *   let x / var x          → always mutable
 *   const x = <primitive>  → safe (skip)
 *   const x = <anything else> → mutable (object/array/new/call can be mutated)
 */
function _collectDescribeScopeVars(bodyStatements) {
  const vars = new Set();
  for (const stmt of bodyStatements) {
    if (stmt.type !== 'VariableDeclaration') { continue; }
    for (const decl of stmt.declarations) {
      if (decl.id.type !== 'Identifier') { continue; }
      if (stmt.kind === 'let' || stmt.kind === 'var') {
        vars.add(decl.id.name);
      } else if (stmt.kind === 'const') {
        // const is safe only for primitive literals
        if (!decl.init || !_isPrimitiveLiteral(decl.init)) {
          vars.add(decl.id.name);
        }
      }
    }
  }
  return vars;
}

/**
 * Given the body statements of a describe callback, collect the AST bodies
 * of all direct it/test callbacks (not nested describes).
 */
function _collectItBodies(bodyStatements) {
  const bodies = [];
  for (const stmt of bodyStatements) {
    if (stmt.type !== 'ExpressionStatement') { continue; }
    const expr = stmt.expression;
    if (expr.type !== 'CallExpression') { continue; }
    if (getCallType(expr) !== 'test') { continue; }
    for (const arg of expr.arguments) {
      if (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression') {
        bodies.push(arg.body);
        break;
      }
    }
  }
  return bodies;
}

/**
 * Analyse a describe callback body and return { isSharedVars, sharedVarNames }.
 *
 * A suite is marked isSharedVars if any variable declared at describe scope is
 * referenced inside any direct it/test callback. The caller also passes in
 * file-scope vars so those are included.
 */
function _analyseDescribeBody(bodyStatements, fileScopeVars) {
  const describeVars = _collectDescribeScopeVars(bodyStatements);
  // Merge file-scope vars — they can also create cross-test dependencies
  const allVars = new Set([...describeVars, ...fileScopeVars]);

  if (allVars.size === 0) { return { isSharedVars: false, sharedVarNames: [] }; }

  const itBodies = _collectItBodies(bodyStatements);
  if (itBodies.length === 0) { return { isSharedVars: false, sharedVarNames: [] }; }

  const sharedVarNames = [];
  for (const varName of allVars) {
    for (const body of itBodies) {
      if (_containsRef(body, varName, 0)) {
        sharedVarNames.push(varName);
        break; // this var is shared — no need to check other it bodies
      }
    }
  }

  return { isSharedVars: sharedVarNames.length > 0, sharedVarNames };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Statically discovers all suites and tests in a source file using AST traversal.
 *
 * @param {string} sourceCode  — raw file content
 * @param {string} sourcePath  — absolute file path (used only for error context)
 * @param {string} rootDir     — project root for resolving Babel packages
 *
 * @returns {{
 *   suites: Array<{
 *     name: string; line: number;
 *     tests: Array<{ name: string; line: number; fullName: string }>;
 *     isSharedVars: boolean; sharedVarNames: string[];
 *   }>;
 *   rootTests: Array<{ name: string; line: number; fullName: string }>;
 * } | null}
 */
function discoverTests(sourceCode, sourcePath, rootDir) {
  if (!loadBabel(rootDir)) { return null; }

  let ast;
  try {
    ast = _parser.parse(sourceCode, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
    });
  } catch (_e) {
    return null;
  }

  // Stack of { name: string, line: number } for nested describe blocks
  const describeStack = [];

  // Suites keyed by full joined name (e.g. "Outer > Inner") — insertion order preserved
  const suiteMap = new Map();

  const rootTests = [];

  // Collect file-scope mutable variables (declared outside any describe/it).
  // These can create cross-test dependencies for every suite in the file.
  const fileScopeVars = _collectDescribeScopeVars(ast.program.body);

  function currentSuiteKey() {
    return describeStack.length ? describeStack.map((d) => d.name).join(' > ') : null;
  }

  function ensureSuite(key, line) {
    if (!suiteMap.has(key)) {
      suiteMap.set(key, { name: key, line, tests: [], isSharedVars: false, sharedVarNames: [] });
    }
    return suiteMap.get(key);
  }

  _traverse(ast, {
    CallExpression: {
      enter(nodePath) {
        const callType = getCallType(nodePath.node);
        if (!callType) { return; }

        const args = nodePath.node.arguments;
        if (args.length < 1) { return; }

        // For describe.each / it.each the first call returns a function that
        // is then called with the name — skip the template array argument.
        const firstArg = args[0];
        const name = getStringValue(firstArg);
        if (!name) { return; }

        const line = nodePath.node.loc?.start?.line ?? 0;

        if (callType === 'describe') {
          describeStack.push({ name, line });
          // Register the suite immediately so it appears even if tests are found later.
          const suite = ensureSuite(currentSuiteKey(), line);

          // Analyse the describe callback body for shared variables.
          // The callback is the last function argument.
          const cb = args.find(
            (a) => a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression',
          );
          if (cb && cb.body && cb.body.type === 'BlockStatement') {
            const { isSharedVars, sharedVarNames } = _analyseDescribeBody(
              cb.body.body,
              fileScopeVars,
            );
            suite.isSharedVars   = isSharedVars;
            suite.sharedVarNames = sharedVarNames;
          }
          return;
        }

        // callType === 'test'
        const suiteKey = currentSuiteKey();
        // fullName matches Jest's test.fullName: "<suite> <test>"
        const fullName = suiteKey ? `${suiteKey} ${name}` : name;

        if (suiteKey) {
          ensureSuite(suiteKey, line).tests.push({ name, line, fullName });
        } else {
          rootTests.push({ name, line, fullName });
        }
      },

      exit(nodePath) {
        if (getCallType(nodePath.node) === 'describe') {
          describeStack.pop();
        }
      },
    },
  });

  return {
    suites:    Array.from(suiteMap.values()),
    rootTests,
  };
}

module.exports = { discoverTests };
