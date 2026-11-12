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

/** Files at the top of `original` missing from its copy `dir` (for a clone of a folder). */
function missingTopFiles(original, dir) {
  let names = [];
  try { names = fs.readdirSync(original, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
  return names.filter((n) => !fs.existsSync(path.join(dir, n)));
}

module.exports = { missingPackages, missingTopFiles };
