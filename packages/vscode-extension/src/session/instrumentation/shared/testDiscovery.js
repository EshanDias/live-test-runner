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

// Injected by TestDiscoveryService (setLogger) so messages reach the
// extension log channel; falls back to the console when used standalone.
let _log = {
  debug: () => {},
  warn:  (m) => console.warn(`[TestDiscovery] ${m}`),
  error: (m) => console.error(`[TestDiscovery] ${m}`),
};

function setLogger(log) { _log = log; }

/**
 * Babel for discovery: the project's own @babel/parser / @babel/traverse when
 * it has them (every Jest project does — the same parser its tests are
 * compiled with), otherwise the parser shipped with the extension
 * (out/vendor, or this package's node_modules during development) and a
 * built-in walker. Vitest projects usually have no Babel.
 */
function loadBabel(rootDir) {
  if (_rootDir === rootDir && _parser) { return true; }
  const fromProject = (id) => {
    try { return require(require.resolve(id, { paths: [rootDir] })); } catch (_) { return undefined; }
  };
  let parser = fromProject('@babel/parser');
  let traverse = parser ? fromProject('@babel/traverse') : undefined;
  if (!parser) {
    parser = bundledParser();
    if (!parser) {
      _log.error(`Could not load @babel/parser for ${rootDir} — no tests can be discovered (the project has no Babel and the extension's own copy is missing)`);
      return false;
    }
    _log.debug(`${rootDir} has no @babel/parser — discovering tests with the extension's own parser`);
  }
  if (traverse && traverse.default) { traverse = traverse.default; }
  _parser = parser;
  _traverse = typeof traverse === 'function' ? traverse : walkCallExpressions;
  _rootDir = rootDir;
  return true;
}

/** The @babel/parser shipped with the extension. */
function bundledParser() {
  const path = require('path');
  const candidates = [
    // Bundled into out/extension.js: out/vendor/ (copied by esbuild.js).
    path.join(__dirname, 'vendor', 'babel-parser.js'),
  ];
  for (const file of candidates) {
    try { return require(file); } catch (_) { /* next */ }
  }
  // Development / unit tests: this package's own devDependency.
  try { return require(require.resolve('@babel/parser', { paths: [__dirname] })); } catch (_) { return undefined; }
}

/** AST keys that never hold child nodes worth visiting. */
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

/**
 * The part of @babel/traverse discovery needs: `CallExpression.enter/exit`
 * with `path.node`, depth-first in source order.
 */
function walkCallExpressions(ast, visitors) {
  const v = visitors.CallExpression || {};
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') { return; }
    const isCall = node.type === 'CallExpression';
    if (isCall && v.enter) { v.enter({ node }); }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) { continue; }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) { if (c && typeof c === 'object') { visit(c); } }
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
    if (isCall && v.exit) { v.exit({ node }); }
  };
  visit(ast.program || ast);
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

/** Names of the describe and test functions in the file being parsed (see discoverTests). */
const DEFAULT_NAMES = { describe: new Set(['describe']), test: new Set(['it', 'test']) };
let _names = DEFAULT_NAMES;

/** Curried modifiers: `test.each([...])(name, fn)`, Vitest's `.for`, `.skipIf(c)`, `.runIf(c)`. */
const CURRIED = new Set(['each', 'for', 'skipIf', 'runIf']);
/** Modifiers that also take a tagged template table: test.each`…`(name, fn). */
const TAGGED = new Set(['each', 'for']);

function _kindOf(name) {
  if (!name) { return null; }
  if (_names.describe.has(name)) { return 'describe'; }
  if (_names.test.has(name)) { return 'test'; }
  return null;
}

/**
 * Returns 'describe' | 'test' | null for a CallExpression node.
 *
 * Handles the Jest and Vitest calling patterns:
 *   describe(name, fn)                       — Identifier
 *   describe.only/skip/concurrent(name, fn)  — MemberExpression, any depth
 *   test.each([...])(name, fn)               — callee is itself a CallExpression
 *   test.for([...]) / test.skipIf(c) / test.runIf(c) (Vitest) — same shape
 *   test.each`table`(name, fn)               — tagged template
 * plus the file's aliases (Vitest `suite`, fixtures from `test.extend`).
 */
function getCallType(node) {
  if (node.type !== 'CallExpression') { return null; }
  const callee = node.callee;

  if (callee.type === 'Identifier') { return _kindOf(callee.name); }
  if (callee.type === 'MemberExpression') { return _kindOf(_memberRoot(callee)); }

  // Curried: test.each([...])(name, fn) — the callee is the test.each([...]) call.
  if (callee.type === 'CallExpression' && callee.callee.type === 'MemberExpression') {
    if (CURRIED.has(_memberLeaf(callee.callee))) { return _kindOf(_memberRoot(callee.callee)); }
  }

  // Curried with a table: test.each`table`(name, fn)
  if (callee.type === 'TaggedTemplateExpression' && callee.tag.type === 'MemberExpression') {
    if (TAGGED.has(_memberLeaf(callee.tag))) { return _kindOf(_memberRoot(callee.tag)); }
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
// Import-shadow detection
// ---------------------------------------------------------------------------

/**
 * Packages that explicitly re-export Jest's own globals.
 * If `describe`/`test`/`it` are imported from these, they ARE Jest globals
 * and should be treated normally.
 */
/** Packages whose describe / it / test are the real test functions (Jest, Vitest). */
const JEST_GLOBAL_PACKAGES = new Set(['@jest/globals', 'jest', 'vitest']);

/**
 * A project's own module (relative path, or a path alias such as `@/…`,
 * `~/…`, `#…`) — e.g. Vitest fixtures: `export const test = base.extend(…)`
 * in ./fixtures.ts. Its test / it / describe are the real ones, extended.
 */
function _isProjectModule(source) {
  return /^(\.{1,2}\/|\/|@\/|~\/|#)/.test(source);
}

/**
 * Scan import declarations at the top of the file and return the set of
 * identifier names that are locally bound from a non-Jest package.
 *
 * Rationale: Jest injects `describe`/`test`/`it` as implicit globals — they
 * do NOT need to be imported. If a file contains:
 *
 *   import { describe, test } from 'tstyche';
 *
 * …those are NOT Jest's globals, even though they share the same name.
 * Calling them does not register Jest test cases, so we must skip them.
 *
 * Exception: `@jest/globals` and `jest` re-export the real Jest globals, so
 * those imports should be treated as normal Jest calls.
 *
 * @param {Array} programBody — ast.program.body
 * @returns {Set<string>} names that shadow Jest globals (e.g. 'describe', 'test')
 */
function _collectShadowedTestGlobals(programBody) {
  const shadowed = new Set();
  for (const node of programBody) {
    if (node.type !== 'ImportDeclaration') { continue; }
    const source = typeof node.source?.value === 'string' ? node.source.value : '';
    if (JEST_GLOBAL_PACKAGES.has(source) || _isProjectModule(source)) { continue; } // real (or extended) test functions
    for (const specifier of (node.specifiers || [])) {
      const localName = specifier.local?.name;
      if (localName === 'describe' || localName === 'test' || localName === 'it') {
        shadowed.add(localName);
      }
    }
  }
  return shadowed;
}

/**
 * The file's describe / test names: the defaults, Vitest's `suite` when
 * imported from vitest, and test functions made with `.extend(…)`:
 *
 *   const myTest = test.extend({ page: async ({}, use) => use(…) });
 *   export const it = base.extend<Fixtures>({ … }).extend({ … });
 */
function _collectTestNames(programBody) {
  const names = { describe: new Set(DEFAULT_NAMES.describe), test: new Set(DEFAULT_NAMES.test) };
  for (const node of programBody) {
    if (node.type !== 'ImportDeclaration' || !JEST_GLOBAL_PACKAGES.has(node.source?.value)) { continue; }
    for (const spec of node.specifiers || []) {
      const imported = spec.imported?.name;
      const local = spec.local?.name;
      if (!imported || !local) { continue; }
      // import { test as base } / { describe as group } / Vitest's { suite }
      if (imported === 'test' || imported === 'it') { names.test.add(local); }
      if (imported === 'describe' || (imported === 'suite' && node.source.value === 'vitest')) { names.describe.add(local); }
    }
  }
  const declarations = (node) => {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    return decl && decl.type === 'VariableDeclaration' ? decl.declarations : [];
  };
  // Aliases can build on each other (base → withDb → withPage): repeat until stable.
  for (let changed = true; changed;) {
    changed = false;
    for (const node of programBody) {
      for (const d of declarations(node)) {
        if (d.id?.type !== 'Identifier' || names.test.has(d.id.name)) { continue; }
        let init = d.init;
        while (init && (init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression' || init.type === 'TSNonNullExpression')) { init = init.expression; }
        if (init?.type !== 'CallExpression' || init.callee.type !== 'MemberExpression') { continue; }
        if (_memberLeaf(init.callee) !== 'extend') { continue; }
        // The object being extended: test / it / an alias, possibly an earlier .extend(…) call.
        let obj = init.callee.object;
        while (obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && _memberLeaf(obj.callee) === 'extend') { obj = obj.callee.object; }
        const root = obj.type === 'Identifier' ? obj.name : obj.type === 'MemberExpression' ? _memberRoot(obj) : null;
        if (root && names.test.has(root)) { names.test.add(d.id.name); changed = true; }
      }
    }
  }
  return names;
}

/**
 * Return the root identifier name of a CallExpression's callee so we can
 * check it against the shadowed-globals set.
 *
 * Examples:
 *   describe(...)            → 'describe'
 *   test.each(...)           → 'test'
 *   it.concurrent.each(...)  → 'it'
 *   test.each`table`(...)    → 'test'
 */
function _getCalleeRootName(node) {
  if (node.type !== 'CallExpression') { return null; }
  const callee = node.callee;
  if (callee.type === 'Identifier') { return callee.name; }
  if (callee.type === 'MemberExpression') { return _memberRoot(callee); }
  // Curried .each: test.each([...])(name, fn)
  if (callee.type === 'CallExpression' && callee.callee?.type === 'MemberExpression') {
    return _memberRoot(callee.callee);
  }
  // Tagged template .each: test.each`table`(name, fn)
  if (callee.type === 'TaggedTemplateExpression' && callee.tag?.type === 'MemberExpression') {
    return _memberRoot(callee.tag);
  }
  return null;
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
 * Returns a **nested** tree of suites — each suite can have `children` sub-suites
 * in addition to `tests`. This directly reflects the nesting of `describe` blocks
 * in the source code.
 *
 * @param {string} sourceCode  — raw file content
 * @param {string} sourcePath  — absolute file path (used only for error context)
 * @param {string} rootDir     — project root for resolving Babel packages
 *
 * @returns {{
 *   suites: Array<{
 *     name: string; line: number;
 *     tests: Array<{ name: string; line: number; fullName: string }>;
 *     children: Array<Suite>;
 *     isSharedVars: boolean; sharedVarNames: string[];
 *   }>;
 *   rootTests: Array<{ name: string; line: number; fullName: string }>;
 * } | null}
 */

/**
 * parser.parse, leaving out plugins this parser rejects: Babel 8 removed
 * some proposals (`decimal`, `recordAndTuple`, …) and options
 * (`pipelineOperator` "minimal") — the rest of the list still applies
 * (decorators, TypeScript, …) instead of the minimal fallback set.
 */
function parseDroppingRemoved(parser, code, options) {
  let plugins = options.plugins;
  for (let i = 0; i < 12; i++) {
    try {
      return parser.parse(code, { ...options, plugins });
    } catch (e) {
      // The error names the plugin it rejects: "The 'decimal' plugin has been
      // removed…", "\"pipelineOperator\" requires \"proposal\" option…".
      const msg = (e && e.message) || '';
      const name = plugins.map((p) => (Array.isArray(p) ? p[0] : p))
        .find((n) => [`'${n}'`, `"${n}"`, `\`${n}\``].some((q) => msg.includes(q)));
      if (!name) { throw e; }
      const next = plugins.filter((p) => (Array.isArray(p) ? p[0] : p) !== name);
      if (next.length === plugins.length) { throw e; }
      plugins = next;
    }
  }
  return parser.parse(code, { ...options, plugins });
}

function discoverTests(sourceCode, sourcePath, rootDir) {
  if (!loadBabel(rootDir)) { return null; }

  // .ts / .mts / .cts are not JSX: with the jsx plugin a generic arrow
  // `<T>(x: T) => …` is read as a tag and the file fails to parse.
  const noJsx = /\.[cm]?ts$/i.test(sourcePath);
  const withoutJsx = (plugins) => (noJsx ? plugins.filter((p) => p !== 'jsx') : plugins);

  let ast;
  try {
    ast = parseDroppingRemoved(_parser, sourceCode, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: withoutJsx([
        // Core syntax
        'jsx',
        'typescript',          // NOTE: conflicts with 'flow' — we prefer typescript

        // Class features
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'classStaticBlock',
        'decoratorAutoAccessors',
        ['decorators', { version: '2023-11' }],

        // Import/export
        'dynamicImport',
        'importAssertions',    // import x assert { type: 'json' }
        'importAttributes',    // import x with { type: 'json' } (newer spec)
        'importMeta',          // import.meta
        'exportDefaultFrom',   // export v from 'mod'
        'exportNamespaceFrom', // export * as ns from 'mod'

        // Operators & expressions
        'optionalChaining',           // a?.b
        'nullishCoalescingOperator',  // a ?? b
        'logicalAssignment',          // a ||= b, a &&= b, a ??= b
        'optionalCatchBinding',       // catch { }
        'throwExpressions',           // () => throw new Error()
        'doExpressions',              // do { }
        'asyncDoExpressions',         // async do { }
        'partialApplication',         // fn(?, 1)

        // Literals & types
        'numericSeparator',    // 1_000_000
        'bigInt',              // 100n
        'decimal',             // 1.5m
        'recordAndTuple',      // #{ }, #[ ]
        'moduleBlocks',        // module { }

        // Async / generators
        'asyncGenerators',     // async function*

        // Misc
        'topLevelAwait',
        'privateIn',           // #x in obj
        'moduleStringNames',   // import { "foo bar" as x }
        'explicitResourceManagement', // using x = ...
        'regexpUnicodeSets',   // /[...]/v
        'functionBind',        // obj::fn
        'functionSent',        // function.sent
        ['pipelineOperator', { proposal: 'minimal' }], // x |> fn
        'v8intrinsic',         // %DebugPrint()
      ]),
    });
  } catch (_e) {
    // Full plugin list failed — could be an older @babel/parser that doesn't support
    // a newer plugin. Retry with a minimal stable set so the file isn't lost entirely.
    _log.debug(`Full-plugin parse failed for ${sourcePath}, retrying with minimal plugins: ${_e && (_e.message || _e)}`);
    try {
      ast = _parser.parse(sourceCode, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        // decorators-legacy: Angular / NestJS / TypeORM test files use decorators (@Component …).
        plugins: withoutJsx(['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator']),
      });
    } catch (_e2) {
      _log.warn(`Could not parse ${sourcePath} — its tests will not appear until it parses: ${_e2 && (_e2.message || _e2)}`);
      return null;
    }
  }

  /**
   * Stack of suite nodes for nested describe blocks.
   * Each entry is a direct reference to the suite object in the tree.
   */
  const describeStack = [];

  /** Top-level suites (direct children of the file). */
  const rootSuites = [];

  const rootTests = [];

  // Collect identifiers (describe/test/it) that are explicitly imported from
  // a non-Jest package (e.g. tstyche). Calls to these are NOT Jest tests.
  const shadowedGlobals = _collectShadowedTestGlobals(ast.program.body);
  _names = _collectTestNames(ast.program.body);

  // Collect file-scope mutable variables (declared outside any describe/it).
  // These can create cross-test dependencies for every suite in the file.
  const fileScopeVars = _collectDescribeScopeVars(ast.program.body);

  /** Build the space-separated fullName prefix from the describe stack. */
  function currentFullNamePrefix() {
    return describeStack.length
      ? describeStack.map((d) => d.name).join(' ')
      : null;
  }

  /** Calls that opened a suite — only these close one on exit. The inner call of
   *  describe.each([...])('name', fn) is also a "describe" call, but opens nothing. */
  const opened = new WeakSet();

  _traverse(ast, {
    CallExpression: {
      enter(nodePath) {
        let callType = getCallType(nodePath.node);
        if (!callType) { return; }

        // Skip calls to identifiers that are locally imported from a non-Jest
        // package (e.g. `import { describe, test } from 'tstyche'`).
        const rootName = _getCalleeRootName(nodePath.node);
        if (rootName && shadowedGlobals.has(rootName)) { return; }

        const args = nodePath.node.arguments;
        if (args.length < 1) { return; }

        // For describe.each / it.each the first call returns a function that
        // is then called with the name — skip the template array argument.
        const firstArg = args[0];
        const name = getStringValue(firstArg);
        if (!name) { return; }

        const line = nodePath.node.loc?.start?.line ?? 0;

        if (callType === 'describe') {
          // Create a new suite node
          const suite = {
            name,
            line,
            tests: [],
            children: [],
            isSharedVars: false,
            sharedVarNames: [],
          };

          // Analyse the describe callback body for shared variables.
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

          // Attach to parent suite or to root
          if (describeStack.length > 0) {
            describeStack[describeStack.length - 1].children.push(suite);
          } else {
            rootSuites.push(suite);
          }

          describeStack.push(suite);
          opened.add(nodePath.node);
          return;
        }

        // callType === 'test'
        const prefix = currentFullNamePrefix();
        // fullName matches Jest's test.fullName: "<suite chain> <test>"
        const fullName = prefix ? `${prefix} ${name}` : name;

        if (describeStack.length > 0) {
          describeStack[describeStack.length - 1].tests.push({ name, line, fullName });
        } else {
          rootTests.push({ name, line, fullName });
        }
      },

      exit(nodePath) {
        if (opened.has(nodePath.node)) {
          describeStack.pop();
        }
      },
    },
  });

  _names = DEFAULT_NAMES;
  return {
    suites:    rootSuites,
    rootTests,
  };
}

module.exports = { discoverTests, setLogger, _parseDroppingRemoved: parseDroppingRemoved };
