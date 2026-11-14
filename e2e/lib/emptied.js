'use strict';
/**
 * macOS empties files in its temp folder that nobody touched for 3 days and
 * keeps the folders. A fixture copy or repo clone there then looks present
 * but is not: npm takes its packages as installed, the tests fail to load.
 */
const fs = require('fs');
const path = require('path');

/** Packages npm's own record says are installed but whose package.json is gone (none when there is no record). */
function missingPackages(dir) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '.package-lock.json'), 'utf8')); } catch { return []; }
  return Object.entries(lock.packages || {})
    .filter(([rel, info]) => rel.startsWith('node_modules/') && !info.link && !fs.existsSync(path.join(dir, rel, 'package.json')))
    .map(([rel]) => rel.slice('node_modules/'.length));
}

/**
 * Packages directly in `dir`/node_modules whose package.json or declared
 * entry files (`main`, `bin`) are gone: any package manager's layout (pnpm
 * links these into its store, which macOS empties the same way).
 */
function brokenPackages(dir) {
  const nm = path.join(dir, 'node_modules');
  let names = [];
  try {
    for (const e of fs.readdirSync(nm)) {
      if (e.startsWith('.')) { continue; }
      if (e.startsWith('@')) { try { names.push(...fs.readdirSync(path.join(nm, e)).map((n) => `${e}/${n}`)); } catch { /* not a folder */ } } else { names.push(e); }
    }
  } catch { return []; }
  const exists = (pkgDir, rel) => ['', '.js', '.cjs', '.mjs', '/index.js'].some((ext) => fs.existsSync(path.join(pkgDir, rel + ext)));
  return names.filter((name) => {
    const pkgDir = path.join(nm, name);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { return fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory() && fs.readdirSync(pkgDir).length > 0 ? true : false; }
    const entries = [...(typeof pkg.main === 'string' ? [pkg.main] : []), ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {}))];
    return entries.some((rel) => typeof rel === 'string' && !exists(pkgDir, rel));
  });
}

/** Files at the top of `original` missing from its copy `dir` (for a clone of a folder). */
function missingTopFiles(original, dir) {
  let names = [];
  try { names = fs.readdirSync(original, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
  return names.filter((n) => !fs.existsSync(path.join(dir, n)));
}

/**
 * Packages of `dir` that lost files since `baseline` (what looked broken
 * right after the install, or in the original of a clone: a package whose
 * own `main` names a file it never shipped is not emptied).
 */
function emptiedPackages(dir, baseline = []) {
  const known = new Set(baseline);
  return [...new Set([...missingPackages(dir), ...brokenPackages(dir).filter((n) => !known.has(n))])];
}

module.exports = { missingPackages, missingTopFiles, brokenPackages, emptiedPackages };
