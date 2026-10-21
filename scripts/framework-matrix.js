#!/usr/bin/env node
'use strict';
/**
 * Copies the framework feature matrix from docs/framework-features.md (the
 * single source) into the README and the HTML guide, between their
 * `<!-- matrix:start -->` / `<!-- matrix:end -->` markers.
 *
 *   node scripts/framework-matrix.js          write both
 *   node scripts/framework-matrix.js --check  exit 1 if either is out of date
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'docs', 'framework-features.md');
const README = path.join(ROOT, 'packages', 'vscode-extension', 'README.md');
const GUIDE = path.join(ROOT, 'docs', 'live-test-runner-guide.html');
const START = '<!-- matrix:start -->';
const END = '<!-- matrix:end -->';

function between(text, file) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i < 0 || j < i) { throw new Error(`${path.relative(ROOT, file)}: no ${START} … ${END} markers`); }
  return { before: text.slice(0, i + START.length), inner: text.slice(i + START.length, j), after: text.slice(j) };
}

const rows = between(fs.readFileSync(SOURCE, 'utf8'), SOURCE).inner
  .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|') && !/^\|[-\s|]+\|$/.test(l))
  .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));

const markdown = `\n${['| ' + rows[0].join(' | ') + ' |', '|' + rows[0].map(() => '---').join('|') + '|',
  ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |')].join('\n')}\n`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/`([^`]+)`/g, '<code>$1</code>');
const html = `\n  <div class="table-wrap"><table>\n    <tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr>\n` +
  rows.slice(1).map((r) => `    <tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n') + '\n  </table></div>\n  ';

const check = process.argv.includes('--check');
let stale = false;
for (const [file, body] of [[README, markdown], [GUIDE, html]]) {
  const text = fs.readFileSync(file, 'utf8');
  const parts = between(text, file);
  const next = parts.before + body + parts.after;
  if (next === text) { continue; }
  stale = true;
  if (!check) { fs.writeFileSync(file, next); console.log(`updated ${path.relative(ROOT, file)}`); }
}
if (check && stale) { console.error('framework matrix out of date — run node scripts/framework-matrix.js'); process.exit(1); }
