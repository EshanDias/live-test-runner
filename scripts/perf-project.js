#!/usr/bin/env node
'use strict';
/**
 * Generates a large synthetic project (Jest, Vitest, pytest or Angular) for performance measurements
 * (scripts/perf-measure.js). Deterministic: the same options always write the
 * same files, so numbers taken on different days compare.
 *
 *   node scripts/perf-project.js <out-dir> [--framework jest|vitest|pytest|angular]
 *                                [--tests 2500] [--sources 600] [--install]
 *
 * Layout: src/lib/mNNN.js source modules (each imports up to two lower-numbered
 * modules, so the import graph has depth), and src/tests/<group>/tNNNN.test.js
 * test files, each importing two or three modules. Some files use nested
 * describes and `test.each`, like real suites. The same project exists for
 * each framework (pytest: src/lib/mNNN.py and tests/gNN/test_tNNNN.py, with
 * classes and parametrize; Angular: the e2e Angular fixture's app project with
 * src/lib/mNNN.ts and src/tests/gNN/tNNNN.spec.ts, run by `ng test`), so
 * numbers compare across frameworks.
 * --install installs the framework into <out-dir> only: `npm install`
 * (Jest, Vitest + @vitest/coverage-v8, or the Angular fixture's packages), or a `.venv` with pytest and
 * coverage for pytest (Python 3.12 through uv when installed).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { out: undefined, framework: 'jest', tests: 2500, sources: 600, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tests') { opts.tests = Number(argv[++i]); }
    else if (a === '--sources') { opts.sources = Number(argv[++i]); }
    else if (a === '--install') { opts.install = true; }
    else if (a === '--framework') { opts.framework = argv[++i]; }
    else if (!a.startsWith('--')) { opts.out = path.resolve(a); }
  }
  if (!opts.out || !(opts.tests > 0) || !(opts.sources > 2) || !['jest', 'vitest', 'pytest', 'angular'].includes(opts.framework)) {
    console.log('Usage: node scripts/perf-project.js <out-dir> [--framework jest|vitest|pytest|angular] [--tests N] [--sources N] [--install]');
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

/** Which lower-numbered modules module i imports (the same for every framework). */
function moduleDeps(i, rand) {
  return i < 2 ? [] : [...new Set([Math.floor(rand() * i), Math.floor(rand() * i)])];
}

function sourceModule(i, deps, fw) {
  if (fw === 'pytest') { return pySourceModule(i, deps); }
  const esm = fw === 'vitest' || fw === 'angular';
  const ts = fw === 'angular';
  const lines = esm ? [] : ["'use strict';"];
  for (const d of deps) {
    lines.push(esm ? `import * as m${d} from './m${pad(d, 3)}${ts ? '' : '.js'}';` : `const m${d} = require('./m${pad(d, 3)}');`);
  }
  lines.push(
    '',
    ts ? `function add${i}(a: unknown, b: unknown): number {` : `function add${i}(a, b) {`,
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
    ts ? `function label${i}(items: unknown[]): string {` : `function label${i}(items) {`,
    '  const out = [];',
    '  for (const item of items) {',
    '    if (item == null) { continue; }',
    `    out.push(String(item).trim()${deps.length > 1 ? ` + m${deps[1]}.base${deps[1]}()` : ''});`,
    '  }',
    "  return out.join(',');",
    '}',
    '',
    ts ? `function pick${i}(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {` : `function pick${i}(obj, keys) {`,
    ts ? '  const res: Record<string, unknown> = {};' : '  const res = {};',
    '  for (const k of keys) {',
    '    if (Object.prototype.hasOwnProperty.call(obj, k)) { res[k] = obj[k]; }',
    '  }',
    '  return res;',
    '}',
    '',
    esm ? `export { add${i}, base${i}, label${i}, pick${i} };` : `module.exports = { add${i}, base${i}, label${i}, pick${i} };`,
    '',
  );
  return lines.join('\n');
}

function pySourceModule(i, deps) {
  const lines = [];
  for (const d of deps) { lines.push(`from . import m${pad(d, 3)} as m${d}`); }
  lines.push(
    '',
    '',
    `def add${i}(a, b):`,
    '    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):',
    "        raise TypeError('numbers only')",
    `    return a + b${deps.length ? ` + m${deps[0]}.base${deps[0]}()` : ''}`,
    '',
    '',
    `def base${i}():`,
    `    return ${i % 7}`,
    '',
    '',
    `def label${i}(items):`,
    '    out = []',
    '    for item in items:',
    '        if item is None:',
    '            continue',
    `        out.append(str(item).strip()${deps.length > 1 ? ` + str(m${deps[1]}.base${deps[1]}())` : ''})`,
    "    return ','.join(out)",
    '',
    '',
    `def pick${i}(obj, keys):`,
    '    res = {}',
    '    for k in keys:',
    '        if k in obj:',
    '            res[k] = obj[k]',
    '    return res',
    '',
  );
  return lines.join('\n');
}

function expectedBase(i) { return i % 7; }

/** Which modules test file n imports (the same for every framework). */
function testMods(sources, rand) {
  const count = 2 + Math.floor(rand() * 2);
  return [...new Set(Array.from({ length: count }, () => Math.floor(rand() * sources)))];
}

function testFile(n, mods, fw) {
  if (fw === 'pytest') { return pyTestFile(n, mods); }
  const esm = fw === 'vitest' || fw === 'angular';
  // Angular's unit-test builder provides Vitest's globals (tsconfig.spec.json: vitest/globals).
  const lines = fw === 'vitest' ? ["import { describe, test, expect } from 'vitest';"] : fw === 'angular' ? [] : ["'use strict';"];
  for (const m of mods) {
    lines.push(esm ? `import * as m${m} from '../../lib/m${pad(m, 3)}${fw === 'angular' ? '' : '.js'}';` : `const m${m} = require('../../lib/m${pad(m, 3)}');`);
  }
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

function pyTestFile(n, mods) {
  const lines = ['import pytest', ''];
  for (const m of mods) { lines.push(`from src.lib import m${pad(m, 3)} as m${m}`); }
  for (const m of mods) {
    lines.push(
      '',
      '',
      `class TestM${m}:`,
      '    def test_base(self):',
      `        assert m${m}.base${m}() == ${expectedBase(m)}`,
      '',
      '    def test_add_returns_a_number(self):',
      `        assert isinstance(m${m}.add${m}(1, 2), int)`,
      '',
      '    def test_add_rejects_strings(self):',
      '        with pytest.raises(TypeError):',
      `            m${m}.add${m}('1', 2)`,
      '',
      '    def test_label_skips_empty_items(self):',
      `        assert m${m}.label${m}([None, ' a ']).startswith('a')`,
      '',
      '    def test_pick_keeps_listed_keys(self):',
      `        assert m${m}.pick${m}({'a': 1, 'b': 2}, ['a']) == {'a': 1}`,
    );
  }
  if (n % 5 === 0) {
    lines.push('', '', "@pytest.mark.parametrize('a,b', [(1, 2), (3, 4), (5, 6)])", 'def test_pairs(a, b):', '    assert a + 1 == b');
  }
  lines.push('');
  return lines.join('\n');
}

function writeProjectFiles(opts) {
  const write = (rel, text) => fs.writeFileSync(path.join(opts.out, rel), text);
  write('.gitignore', 'node_modules/\n.venv/\n__pycache__/\n');
  if (opts.framework === 'pytest') {
    write('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\npythonpath = ["."]\n');
    for (const d of ['src', path.join('src', 'lib')]) { write(path.join(d, '__init__.py'), ''); }
    return;
  }
  if (opts.framework === 'angular') { writeAngularFiles(opts); return; }
  const vitest = opts.framework === 'vitest';
  write('package.json', JSON.stringify({
    name: `ltr-perf-large-${opts.framework}`,
    private: true,
    ...(vitest ? { type: 'module' } : {}),
    scripts: { test: vitest ? 'vitest' : 'jest' },
    devDependencies: vitest ? { vitest: '3.2.4', '@vitest/coverage-v8': '3.2.4' } : { jest: '29.7.0' },
  }, null, 2) + '\n');
  if (vitest) {
    write('vitest.config.js', "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { environment: 'node' } });\n");
  } else {
    write('jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
  }
}

/**
 * The e2e Angular fixture's app project (configs, src/ without its spec files,
 * which fail on purpose), without the library project.
 */
function writeAngularFiles(opts) {
  const fixture = path.join(__dirname, '..', 'e2e', 'fixtures', 'angular');
  const read = (rel) => fs.readFileSync(path.join(fixture, rel), 'utf8');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(opts.out, rel)), { recursive: true }); fs.writeFileSync(path.join(opts.out, rel), text); };
  const pkg = JSON.parse(read('package.json'));
  pkg.name = 'ltr-perf-large-angular';
  delete pkg.devDependencies['ng-packagr'];
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  const ng = JSON.parse(read('angular.json'));
  delete ng.projects.mylib;
  write('angular.json', JSON.stringify(ng, null, 2) + '\n');
  // tsconfig.json: without its leading comments, the library's path and reference.
  const tsconfig = JSON.parse(read('tsconfig.json').replace(/\/\*[\s\S]*?\*\//g, ''));
  delete tsconfig.compilerOptions.paths;
  tsconfig.references = tsconfig.references.filter((r) => !/mylib/.test(r.path));
  write('tsconfig.json', JSON.stringify(tsconfig, null, 2) + '\n');
  for (const f of ['tsconfig.app.json', 'tsconfig.spec.json']) { write(f, read(f)); }
  const copySrc = (rel) => {
    for (const e of fs.readdirSync(path.join(fixture, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { copySrc(r); } else if (!/\.spec\.ts$/.test(e.name)) { write(r, read(r)); }
    }
  };
  copySrc('src');
}

function install(opts) {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: opts.out, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { process.exit(r.status ?? 1); }
  };
  if (opts.framework === 'pytest') {
    const py = path.join(opts.out, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
    if (fs.existsSync(py)) { return; }
    // The extension needs Python 3.12+: uv provides it when installed, else the PATH's python3 must be new enough.
    if (spawnSync('uv', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0) {
      run('uv', ['venv', '--quiet', '--python', '3.12', '.venv']);
      run('uv', ['pip', 'install', '--quiet', '--python', py, 'pytest', 'coverage']);
      return;
    }
    run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', '.venv']);
    run(py, ['-m', 'pip', 'install', '--quiet', 'pytest', 'coverage']);
    return;
  }
  if (!fs.existsSync(path.join(opts.out, 'node_modules', opts.framework === 'angular' ? '@angular/build' : opts.framework))) {
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error']);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rand = rng(20261110);
  const py = opts.framework === 'pytest';
  const ext = py ? '.py' : opts.framework === 'angular' ? '.ts' : '.js';
  const lib = path.join(opts.out, 'src', 'lib');
  const testsDir = py ? path.join(opts.out, 'tests') : path.join(opts.out, 'src', 'tests');
  fs.rmSync(path.join(opts.out, 'src'), { recursive: true, force: true });
  fs.rmSync(path.join(opts.out, 'tests'), { recursive: true, force: true });
  fs.mkdirSync(lib, { recursive: true });

  for (let i = 0; i < opts.sources; i++) {
    fs.writeFileSync(path.join(lib, `m${pad(i, 3)}${ext}`), sourceModule(i, moduleDeps(i, rand), opts.framework));
  }
  for (let n = 0; n < opts.tests; n++) {
    const dir = path.join(testsDir, `g${pad(Math.floor(n / 100), 2)}`);
    fs.mkdirSync(dir, { recursive: true });
    const name = py ? `test_t${pad(n, 4)}.py` : opts.framework === 'angular' ? `t${pad(n, 4)}.spec.ts` : `t${pad(n, 4)}.test.js`;
    fs.writeFileSync(path.join(dir, name), testFile(n, testMods(opts.sources, rand), opts.framework));
  }
  writeProjectFiles(opts);
  console.log(`[perf-project] ${opts.framework}: ${opts.tests} test file(s), ${opts.sources} source module(s) in ${opts.out}`);
  if (opts.install) { install(opts); }
}

main();
