#!/usr/bin/env node
'use strict';
/**
 * Generates a large synthetic Jest project for performance measurements
 * (scripts/perf-measure.js). Deterministic: the same options always write the
 * same files, so numbers taken on different days compare.
 *
 *   node scripts/perf-project.js <out-dir> [--tests 2500] [--sources 600] [--install]
 *
 * Layout: src/lib/mNNN.js source modules (each imports up to two lower-numbered
 * modules, so the import graph has depth), and src/tests/<group>/tNNNN.test.js
 * test files, each importing two or three modules. Some files use nested
 * describes and `test.each`, like real suites. --install runs `npm install`
 * in <out-dir> (Jest only; nothing else is installed).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { out: undefined, tests: 2500, sources: 600, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tests') { opts.tests = Number(argv[++i]); }
    else if (a === '--sources') { opts.sources = Number(argv[++i]); }
    else if (a === '--install') { opts.install = true; }
    else if (!a.startsWith('--')) { opts.out = path.resolve(a); }
  }
  if (!opts.out || !(opts.tests > 0) || !(opts.sources > 2)) {
    console.log('Usage: node scripts/perf-project.js <out-dir> [--tests N] [--sources N] [--install]');
    process.exit(2);
  }
  return opts;
}

/** Small seeded PRNG (mulberry32): same seed, same project. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w) => String(n).padStart(w, '0');

function sourceModule(i, rand) {
  const deps = i < 2 ? [] : [...new Set([Math.floor(rand() * i), Math.floor(rand() * i)])];
  const lines = ["'use strict';"];
  for (const d of deps) { lines.push(`const m${d} = require('./m${pad(d, 3)}');`); }
  lines.push(
    '',
    `function add${i}(a, b) {`,
    '  if (typeof a !== \'number\' || typeof b !== \'number\') {',
    "    throw new TypeError('numbers only');",
    '  }',
    `  return a + b${deps.length ? ` + m${deps[0]}.base${deps[0]}()` : ''};`,
    '}',
    '',
    `function base${i}() {`,
    `  return ${i % 7};`,
    '}',
    '',
    `function label${i}(items) {`,
    '  const out = [];',
    '  for (const item of items) {',
    '    if (item == null) { continue; }',
    `    out.push(String(item).trim()${deps.length > 1 ? ` + m${deps[1]}.base${deps[1]}()` : ''});`,
    '  }',
    "  return out.join(',');",
    '}',
    '',
    `function pick${i}(obj, keys) {`,
    '  const res = {};',
    '  for (const k of keys) {',
    '    if (Object.prototype.hasOwnProperty.call(obj, k)) { res[k] = obj[k]; }',
    '  }',
    '  return res;',
    '}',
    '',
    `module.exports = { add${i}, base${i}, label${i}, pick${i} };`,
    '',
  );
  return lines.join('\n');
}

function expectedBase(i) { return i % 7; }

function testFile(n, sources, rand) {
  const count = 2 + Math.floor(rand() * 2);
  const mods = [...new Set(Array.from({ length: count }, () => Math.floor(rand() * sources)))];
  const lines = ["'use strict';"];
  for (const m of mods) { lines.push(`const m${m} = require('../../lib/m${pad(m, 3)}');`); }
  lines.push('', `describe('suite ${n}', () => {`);
  for (const m of mods) {
    lines.push(
      `  describe('m${m}', () => {`,
      `    test('base is ${expectedBase(m)}', () => {`,
      `      expect(m${m}.base${m}()).toBe(${expectedBase(m)});`,
      '    });',
      "    test('add returns a number', () => {",
      `      expect(typeof m${m}.add${m}(1, 2)).toBe('number');`,
      '    });',
      "    test('add rejects strings', () => {",
      `      expect(() => m${m}.add${m}('1', 2)).toThrow(TypeError);`,
      '    });',
      "    test('label skips empty items', () => {",
      `      expect(m${m}.label${m}([null, ' a ']).startsWith('a')).toBe(true);`,
      '    });',
      "    test('pick keeps listed keys', () => {",
      `      expect(m${m}.pick${m}({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });`,
      '    });',
      '  });',
    );
  }
  if (n % 5 === 0) {
    lines.push(
      '  test.each([[1, 2], [3, 4], [5, 6]])(\'pairs %i and %i\', (a, b) => {',
      '    expect(a + 1).toBe(b);',
      '  });',
    );
  }
  lines.push('});', '');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rand = rng(20261110);
  const lib = path.join(opts.out, 'src', 'lib');
  const testsDir = path.join(opts.out, 'src', 'tests');
  fs.rmSync(path.join(opts.out, 'src'), { recursive: true, force: true });
  fs.mkdirSync(lib, { recursive: true });

  for (let i = 0; i < opts.sources; i++) { fs.writeFileSync(path.join(lib, `m${pad(i, 3)}.js`), sourceModule(i, rand)); }
  for (let n = 0; n < opts.tests; n++) {
    const dir = path.join(testsDir, `g${pad(Math.floor(n / 100), 2)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `t${pad(n, 4)}.test.js`), testFile(n, opts.sources, rand));
  }
  fs.writeFileSync(path.join(opts.out, 'package.json'), JSON.stringify({
    name: 'ltr-perf-large',
    private: true,
    scripts: { test: 'jest' },
    devDependencies: { jest: '29.7.0' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(opts.out, 'jest.config.js'), "module.exports = { testEnvironment: 'node' };\n");
  fs.writeFileSync(path.join(opts.out, '.gitignore'), 'node_modules/\n');
  console.log(`[perf-project] ${opts.tests} test file(s), ${opts.sources} source module(s) in ${opts.out}`);

  if (opts.install && !fs.existsSync(path.join(opts.out, 'node_modules', 'jest'))) {
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: opts.out, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { process.exit(r.status ?? 1); }
  }
}

main();
