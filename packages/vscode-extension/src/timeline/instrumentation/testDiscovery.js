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
 *   suites: Array<{ name: string; line: number; tests: Array<{ name: string; line: number; fullName: string }> }>;
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

  function currentSuiteKey() {
    return describeStack.length ? describeStack.map((d) => d.name).join(' > ') : null;
  }

  function ensureSuite(key, line) {
    if (!suiteMap.has(key)) {
      suiteMap.set(key, { name: key, line, tests: [] });
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
          ensureSuite(currentSuiteKey(), line);
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
