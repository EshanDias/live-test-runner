'use strict';
/**
 * vitestTraceTransform.js — the light-trace instrumentation for Vitest.
 *
 * Same contract as the Jest transform (`__strace.step(line, file)` before
 * every statement, see docs/architecture.md → Session instrumentation
 * protocol) but without coverage counters — Vitest measures coverage with its
 * own provider — and without Babel's traverse / generator, which Vitest
 * projects usually lack: the source is parsed with @babel/parser and the
 * calls are spliced into the original text.
 *
 * Runs on the module as Vite's earlier transforms left it (TypeScript, JSX,
 * Vue already compiled — a Vite `enforce: 'post'` transform): the recorded
 * line numbers come from the incoming source map, so they are the editor's.
 * Every insertion stays on its line (no newline is ever added), and the
 * returned source map maps every token to its new column — Vite chains it
 * with the earlier maps, and coverage maps through it exactly as through
 * Babel's own maps. The inserted text is unmapped, except a wrapper's `{` /
 * `}` / `return ` (see buildMap).
 *
 * Pure: no file system, no globals — unit tested in the extension package.
 */

/**
 * The inserted texts are recognisable, so the setup file's
 * Function.prototype.toString can remove them and a function serialised with
 * toString() (page.evaluate, workers, sandboxes) is its original source:
 *   step:        /* istanbul ignore next *\/globalThis.__strace?.step(L,"file");
 *   wrapper:     {<step>/*ltr{*\/  …  /*ltr}*\/}
 *   arrow body:  {<step>return /*ltr{*\/ expr /*ltr}*\/}
 * (VLQ-mapped so that coverage still finds every original node; see buildMap.)
 */
// `istanbul ignore next`: coverage (Vitest's AST-aware v8 remapping and the
// istanbul provider both read it) skips the call. Without it a tool that
// cannot map the call's start retries with the next mapped position — the
// original statement — and counts the call as an extra statement there.
const { sourceMapLookup } = require('../shared/sourceMapLookup.js');

const IGNORE = '/* istanbul ignore next */';
const STEP = 'globalThis.__strace?.step';
const OPEN_MARK = '/*ltr{*/';
const CLOSE_MARK = '/*ltr}*/';

const STEP_CALL = String.raw`\/\* istanbul ignore next \*\/globalThis\.__strace\?\.step\(\d+,"(?:[^"\\]|\\.)*"\);`;
const OPENERS = new RegExp(String.raw`\{${STEP_CALL}(?:return )?\/\*ltr\{\*\/`, 'g');
const CLOSERS = /\/\*ltr\}\*\/\}/g;
const STEPS = new RegExp(STEP_CALL, 'g');

/** Instrumented source with the insertions removed (they are pure insertions): the original text. */
function withoutTrace(source) {
  if (typeof source !== 'string' || !source.includes('__strace?.step')) { return source; }
  return source.replace(OPENERS, '').replace(CLOSERS, '').replace(STEPS, '');
}

/** Statement types that never get a step call (declarations, types, blocks). */
const SKIP_STATEMENTS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'BlockStatement',
  'EmptyStatement',
  'SwitchStatement',
  'LabeledStatement',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSDeclareFunction',
  'TSModuleDeclaration',
  'TSEnumDeclaration',
  'TSImportEqualsDeclaration',
  'TSExportAssignment',
  'TSNamespaceExportDeclaration',
]);

/** Statement positions that are not in a list: wrapped as `{ step; stmt }`. */
const SINGLE_STATEMENT_KEYS = {
  IfStatement: ['consequent', 'alternate'],
  ForStatement: ['body'],
  ForInStatement: ['body'],
  ForOfStatement: ['body'],
  WhileStatement: ['body'],
  DoWhileStatement: ['body'],
};

/** AST keys that hold no child nodes. */
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors', 'typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters']);

function parserPlugins(file) {
  const ext = (/\.([cm]?[jt]sx?)$/i.exec(file) || [])[1] || 'js';
  const lower = ext.toLowerCase();
  const isTs = lower.includes('ts');
  const isJsx = lower.endsWith('x') || !isTs; // plain .js may hold JSX (Vite accepts it for .jsx only, but parsing it does no harm)
  const plugins = ['decorators-legacy', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'topLevelAwait', 'importAttributes'];
  if (isTs) { plugins.push('typescript'); }
  if (isJsx) { plugins.push('jsx'); }
  return plugins;
}

function parse(parser, code, file) {
  const base = {
    tokens: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowUndeclaredExports: true,
    plugins: parserPlugins(file),
  };
  try {
    return parser.parse(code, { ...base, sourceType: 'module' });
  } catch (first) {
    // JSX in a plain .js file that is really TS-free but ambiguous, or a script.
    try { return parser.parse(code, { ...base, sourceType: 'script' }); } catch (_) { throw first; }
  }
}

/** Every statement that gets a step call, with how it is inserted. */
function collect(ast) {
  const tokens = ast.tokens || [];
  /** @type {{ at: number, text: string, line?: number, close?: number }[]} */
  const edits = [];
  const step = (line) => ({ line });

  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') { return; }
    // Type-only subtrees hold no runtime code.
    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSSatisfiesExpression' &&
        node.type !== 'TSNonNullExpression' && node.type !== 'TSTypeAssertion' && node.type !== 'TSParameterProperty' &&
        node.type !== 'TSEnumDeclaration' && node.type !== 'TSModuleDeclaration' && node.type !== 'TSModuleBlock' &&
        node.type !== 'TSExportAssignment' && node.type !== 'TSInstantiationExpression') {
      return;
    }
    if (node.declare) { return; } // `declare const x: T`

    // An expression-bodied arrow: `(a) => a + b` → `(a) => {__strace.step(L, F);return a + b}`
    // (a block, not a comma expression: coverage then still finds the body
    // as one statement starting where the expression did).
    if (node.type === 'ArrowFunctionExpression' && node.body && node.body.type !== 'BlockStatement' && node.body.loc) {
      const range = outerRange(node.body, tokens);
      edits.push({ at: range.start, kind: 'arrow', end: range.end, body: node.body.start, ...step(node.body.loc.start.line) });
    }

    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) { continue; }
      const child = node[k];
      if (Array.isArray(child)) {
        const isStatementList = (k === 'body' && (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'TSModuleBlock')) ||
          (k === 'consequent' && node.type === 'SwitchCase');
        for (const c of child) {
          if (!c || typeof c !== 'object') { continue; }
          if (isStatementList && isInstrumented(c)) {
            edits.push({ at: hintStart(c), kind: 'stmt', ...step(c.loc.start.line) });
          }
          visit(c, node, k);
        }
      } else if (child && typeof child === 'object') {
        const singles = SINGLE_STATEMENT_KEYS[node.type];
        if (singles && singles.includes(k) && child.type !== 'BlockStatement' && isInstrumented(child) && child.loc) {
          edits.push({ at: child.start, kind: 'block', end: child.end, ...step(child.loc.start.line) });
        }
        visit(child, node, k);
      }
    }
  };
  visit(ast.program, undefined, undefined);
  return edits;
}

/** A coverage ignore hint must stay right before its statement: insert before the hint. */
const IGNORE_HINT = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next)/;
function hintStart(stmt) {
  const hint = (stmt.leadingComments || []).find((c) => IGNORE_HINT.test(c.value));
  return hint ? Math.min(hint.start, stmt.start) : stmt.start;
}

/** A node's range including the parentheses around it (`({ a })`). */
function outerRange(node, tokens) {
  const extra = node.extra;
  if (!extra || !extra.parenthesized || typeof extra.parenStart !== 'number') { return { start: node.start, end: node.end }; }
  const label = (t) => (t.type && typeof t.type === 'object' ? t.type.label : t.type);
  let opens = 0;
  let i = firstTokenAt(tokens, extra.parenStart);
  for (; i < tokens.length && tokens[i].start < node.start; i++) { if (label(tokens[i]) === '(') { opens++; } }
  let end = node.end;
  for (i = firstTokenAt(tokens, node.end); i < tokens.length && opens > 0; i++) {
    if (label(tokens[i]) === ')') { opens--; end = tokens[i].end; }
  }
  return { start: extra.parenStart, end };
}

function firstTokenAt(tokens, offset) {
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid].start < offset) { lo = mid + 1; } else { hi = mid; } }
  return lo;
}

function isInstrumented(stmt) {
  if (!stmt || !stmt.loc || typeof stmt.start !== 'number') { return false; }
  if (SKIP_STATEMENTS.has(stmt.type)) { return false; }
  if (stmt.type.startsWith('TS') && stmt.type !== 'TSExportAssignment') { return false; }
  if (stmt.declare) { return false; }
  // `vi.mock(...)` / `vi.hoisted(...)` are hoisted by Vitest — leave them alone.
  if (stmt.type === 'ExpressionStatement' && stmt.expression && stmt.expression.type === 'CallExpression') {
    const callee = stmt.expression.callee;
    if (callee && callee.type === 'MemberExpression' && callee.object && callee.object.type === 'Identifier' &&
        callee.object.name === 'vi' && callee.property && /^(mock|doMock|unmock|doUnmock|hoisted)$/.test(callee.property.name || '')) {
      return false;
    }
  }
  return true;
}

// ── Source map ───────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n) {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) { digit |= 32; }
    out += B64[digit];
  } while (v > 0);
  return out;
}

/**
 * Line starts (offsets) of `code`.
 * @returns {number[]}
 */
function lineStarts(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i);
    if (ch === 10) { starts.push(i + 1); }
    else if (ch === 13) {
      if (code.charCodeAt(i + 1) === 10) { i++; }
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
  }
  return lo;
}

/** Offsets in text[from, to) where a word, a string or a punctuation character starts. */
function tokenStarts(text, from, to) {
  const out = [];
  for (let k = from; k < to; k++) {
    if (text[k] === '"') {
      out.push(k);
      const close = text.indexOf('"', k + 1);
      k = close < 0 ? to : close;
      continue;
    }
    const word = /[\w$]/.test(text[k]);
    if (k === from || !word || !/[\w$]/.test(text[k - 1])) { out.push(k); }
  }
  return out;
}

/**
 * Builds the source map for `code` with `inserts` ({ at, text }, sorted by
 * `at`) spliced in: one segment per original token (and line start) at its
 * shifted column, one unmapped segment per insertion.
 */
function buildMap(code, inserts, tokens, file) {
  const starts = lineStarts(code);
  const points = new Set(starts);
  for (const t of tokens) { if (typeof t.start === 'number' && t.start <= code.length) { points.add(t.start); } }
  for (const ins of inserts) { points.add(ins.at); }
  const sorted = [...points].sort((a, b) => a - b);

  const lines = starts.map(() => []);
  let i = 0;        // next insert
  let line = -1;
  let shift = 0;    // characters inserted on this line before the current point
  for (const offset of sorted) {
    const l = lineOf(starts, offset);
    if (l !== line) { line = l; shift = 0; }
    while (i < inserts.length && inserts[i].at < offset) {
      if (inserts[i].at >= starts[line]) { shift += inserts[i].text.length; }
      i++;
    }
    const origCol = offset - starts[line];
    // Inserted text here. Its mapped chunks (a `{` that opens a wrapper
    // block, a closing `}`, an arrow's `return `) map to an original position,
    // so a node they now start or end still maps — coverage drops nodes
    // whose start or end does not. The rest (markers, step calls) is unmapped.
    while (i < inserts.length && inserts[i].at === offset) {
      const ins = inserts[i];
      const col = origCol + shift;
      let cursor = 0;
      const gaps = (from, to) => {
        // One unmapped segment at every token start of the inserted text:
        // coverage tools that miss on a lookup retry with the NEXT segment
        // (ast-v8-to-istanbul), which must not be the original code after it.
        for (const k of tokenStarts(ins.text, from, to)) { lines[line].push({ col: col + k, gap: true }); }
      };
      for (const chunk of ins.mapped || []) {
        if (chunk.index > cursor) { gaps(cursor, chunk.index); }
        const to = typeof chunk.to === 'number' ? chunk.to : offset;
        const toLine = lineOf(starts, to);
        lines[line].push({ col: col + chunk.index, origCol: to - starts[toLine], origLine: toLine });
        cursor = chunk.index + chunk.len;
      }
      if (cursor < ins.text.length) { gaps(cursor, ins.text.length); }
      shift += ins.text.length;
      i++;
    }
    lines[line].push({ col: origCol + shift, origCol });
  }

  const out = [];
  let prevOrigLine = 0, prevOrigCol = 0;
  for (let l = 0; l < lines.length; l++) {
    let prevCol = 0;
    const segs = [];
    for (const seg of lines[l]) {
      if (seg.gap) {
        segs.push(vlq(seg.col - prevCol));
      } else {
        const ol = seg.origLine === undefined ? l : seg.origLine;
        segs.push(vlq(seg.col - prevCol) + vlq(0) + vlq(ol - prevOrigLine) + vlq(seg.origCol - prevOrigCol));
        prevOrigLine = ol;
        prevOrigCol = seg.origCol;
      }
      prevCol = seg.col;
    }
    out.push(segs.join(','));
  }
  return { version: 3, file, sources: [file], sourcesContent: [code], names: [], mappings: out.join(';') };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * The original line (1-based) at a generated position (0-based line, column),
 * through the incoming map — segments for other sources ignored — or
 * undefined (unmapped).
 */
function originalLineLookup(map, file) {
  const lookup = sourceMapLookup(map, file);
  if (!lookup) { throw new Error('the incoming source map cannot be read'); }
  return (line0, col) => { const p = lookup(line0, col); return p && p.line; };
}

/**
 * Instruments one module.
 * @param {string} code the module's code as the transform sees it
 * @param {string} file absolute path (recorded in the trace)
 * @param {{ parse: Function }} parser @babel/parser
 * @param {object} [inputMap] source map from `code` back to the file's own source
 *   (earlier transforms: TypeScript, Vue, …): recorded lines are the original
 *   lines; statements it does not map are not traced. None: `code` is the source.
 * @returns {{ code: string, map: object, statements: number } | null} null when nothing to instrument
 * @throws when the file cannot be parsed
 */
function instrument(code, file, parser, inputMap) {
  const ast = parse(parser, code, file);
  let edits = collect(ast);
  if (inputMap) {
    const lookup = originalLineLookup(inputMap, file);
    const starts = lineStarts(code);
    edits = edits.flatMap((e) => {
      const offset = e.kind === 'arrow' ? e.body : e.at;
      const l = lineOf(starts, offset);
      const line = lookup(l, offset - starts[l]);
      return line === undefined ? [] : [{ ...e, line }];
    });
  }
  if (edits.length === 0) { return null; }
  const F = JSON.stringify(file);
  // Optional call, no preamble: a worker without the setup file (or Vitest's
  // main process) runs the code unchanged, and there is no `if` / `||` /
  // function for coverage to count.
  const call = (line) => `${IGNORE}${STEP}(${line},${F});`;

  /** @type {{ at: number, text: string, mapped?: { index: number, len: number, to?: number }[], order?: number, closes?: number }[]} */
  const inserts = [];
  let order = 0;
  for (const e of edits) {
    if (e.kind === 'stmt') {
      inserts.push({ at: e.at, text: call(e.line), order: order++ });
    } else if (e.kind === 'block') {
      inserts.push({ at: e.at, text: `{${call(e.line)}${OPEN_MARK}`, mapped: [{ index: 0, len: 1 }], order: order++ });
      inserts.push({ at: e.end, text: `${CLOSE_MARK}}`, mapped: [{ index: CLOSE_MARK.length, len: 1 }], closes: order - 1 });
    } else if (e.kind === 'arrow') {
      const open = `{${call(e.line)}`;
      inserts.push({
        at: e.at,
        text: `${open}return ${OPEN_MARK}`,
        mapped: [{ index: 0, len: 1 }, { index: open.length, len: 7, to: e.body }],
        order: order++,
      });
      inserts.push({ at: e.end, text: `${CLOSE_MARK}}`, mapped: [{ index: CLOSE_MARK.length, len: 1 }], closes: order - 1 });
    }
  }
  // At one offset: closing text first, innermost (latest opened) first, then
  // openings in document order (outer before inner).
  const rank = (x) => (x.closes !== undefined ? -1e9 - x.closes : x.order);
  inserts.sort((a, b) => a.at - b.at || rank(a) - rank(b));

  let out = '';
  let pos = 0;
  for (const ins of inserts) {
    out += code.slice(pos, ins.at) + ins.text;
    pos = ins.at;
  }
  out += code.slice(pos);
  const map = buildMap(code, inserts, ast.tokens || [], file);
  return { code: out, map, statements: edits.length };
}

module.exports = { instrument, withoutTrace, STEP, OPEN_MARK, CLOSE_MARK, _buildMap: buildMap, _vlq: vlq, _originalLineLookup: originalLineLookup };
