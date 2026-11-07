#!/usr/bin/env node
'use strict';
/**
 * Builds the GitHub Wiki from docs/: one wiki page per Markdown file, links
 * rewritten to wiki page names, a sidebar with the contents, and a note on each
 * page pointing at its source file (the Wiki is a copy; docs/ is the source).
 *
 *   node scripts/build-wiki.js <out-dir>   write the pages
 *   node scripts/build-wiki.js --check     only check that every link resolves
 *
 * Page names come from each file's first "# " heading, so two files with the
 * same heading are an error. docs/README.md becomes the wiki's Home page.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const REPO = process.env.GITHUB_REPOSITORY || 'EshanDias/live-test-runner';
const BRANCH = 'main';
const GUIDE_URL = 'https://eshandias.github.io/live-test-runner/guide/';

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { return markdownFiles(p); }
    return e.name.endsWith('.md') ? [p] : [];
  });
}

function titleOf(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^# (.+)$/m);
  if (!m) { throw new Error(`${rel(file)} has no "# " heading`); }
  return m[1].trim();
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const pageName = (title) => title.replace(/[\\/:*?"<>|#]/g, '').replace(/\s+/g, '-');
const githubUrl = (p) => `https://github.com/${REPO}/${fs.existsSync(p) && fs.statSync(p).isDirectory() ? 'tree' : 'blob'}/${BRANCH}/${rel(p)}`;

function build() {
  const files = markdownFiles(DOCS).sort();
  const pages = new Map(); // absolute path → { name, title }
  const byName = new Map();
  for (const f of files) {
    const title = titleOf(f);
    const name = f === path.join(DOCS, 'README.md') ? 'Home' : pageName(title);
    if (byName.has(name)) { throw new Error(`${rel(f)} and ${rel(byName.get(name))} would both be the wiki page "${name}": give one a different heading`); }
    byName.set(name, f);
    pages.set(f, { name, title });
  }

  const broken = [];
  const out = new Map(); // wiki file name → content
  for (const [file, { name }] of pages) {
    let text = fs.readFileSync(file, 'utf8');
    text = text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang, label, target) => {
      if (/^([a-z]+:|#)/i.test(target)) { return all; }
      const [p, anchor] = target.split('#');
      const abs = path.resolve(path.dirname(file), decodeURI(p));
      const hash = anchor ? `#${anchor}` : '';
      if (!fs.existsSync(abs)) { broken.push(`${rel(file)}: ${target}`); return all; }
      if (abs === path.join(DOCS, 'live-test-runner-guide.html')) { return `${bang}[${label}](${GUIDE_URL}${hash})`; }
      const page = pages.get(abs) ?? pages.get(path.join(abs, 'README.md'));
      if (page && !bang) { return `[${label}](${page.name}${hash})`; }
      return `${bang}[${label}](${githubUrl(abs)}${bang ? '?raw=true' : ''}${hash})`;
    });
    const source = `https://github.com/${REPO}/blob/${BRANCH}/${rel(file)}`;
    out.set(`${name}.md`, `${text.trimEnd()}\n\n---\n\n<sub>Source: [${rel(file)}](${source}). This Wiki is generated from the repository; to change a page, open a pull request that edits its file in \`docs/\`.</sub>\n`);
  }

  // Sidebar: the same sections as the contents page.
  const section = (dir) => [...pages].filter(([f]) => path.dirname(f) === path.join(DOCS, dir) && path.basename(f) !== 'README.md')
    .map(([, p]) => `- [${p.title}](${p.name})`);
  const pageAt = (p) => pages.get(path.join(DOCS, p));
  const sidebar = [
    '**[Home](Home)**', '',
    '**Features**', ...section('features'), '',
    '**Requirements**', ...section('requirements'), '',
    '**Development**',
    ...['development/developer-guide.md', 'development/architecture.md', 'development/framework-features.md', 'development/ai-context.md']
      .map(pageAt).filter(Boolean).map((p) => `- [${p.title}](${p.name})`),
    '- Feature designs', ...section('development/design').map((l) => `  ${l}`), '',
    `[User guide](${GUIDE_URL}) · [Report a bug](https://github.com/${REPO}/issues/new/choose)`,
  ];
  out.set('_Sidebar.md', `${sidebar.join('\n')}\n`);
  return { out, broken };
}

function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: build-wiki.js <out-dir> | --check'); process.exit(2); }
  const { out, broken } = build();
  if (broken.length > 0) {
    console.error(`Broken links in docs/:\n  ${broken.join('\n  ')}`);
    process.exit(1);
  }
  if (arg === '--check') { console.log(`docs/: ${out.size - 1} pages, every link resolves`); return; }
  fs.mkdirSync(arg, { recursive: true });
  for (const [name, content] of out) { fs.writeFileSync(path.join(arg, name), content); }
  console.log(`Wrote ${out.size} files to ${arg}`);
}

main();
