import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoverageStore } from '../src/coverage/CoverageStore';
import { applyIstanbulCoverage, IstanbulFileCoverage, toManifest } from '../src/coverage/istanbulCoverage';
import { isExcludedFromCoverage } from '../src/coverage/coverageRules';

/** Vitest's coverage-final.json (istanbul shape, v8 and istanbul providers) → the CoverageStore. */

const loc = (line: number, column: number, endLine = line, endCol = column + 10) => ({
  start: { line, column }, end: { line: endLine, column: endCol },
});

/** `add` (called) and `sub` (not called), one `if` with two arms. */
function mathCoverage(file: string, s: number[], f: number[], b: number[]): IstanbulFileCoverage {
  return {
    path: file,
    statementMap: { 0: loc(1, 0), 1: loc(2, 2), 2: loc(5, 2), 3: loc(6, 2) },
    fnMap: {
      0: { name: 'add', decl: loc(1, 16, 1, 19), loc: loc(1, 0, 3, 1), line: 1 },
      1: { name: 'sub', decl: loc(4, 16, 4, 19), loc: loc(4, 0, 7, 1), line: 4 },
    },
    branchMap: { 0: { type: 'if', loc: loc(5, 2), locations: [loc(5, 2), loc(5, 2)], line: 5 } },
    s: Object.fromEntries(s.map((v, i) => [i, v])),
    f: Object.fromEntries(f.map((v, i) => [i, v])),
    b: { 0: b },
  };
}

let root: string;
let manifests: string;
let store: CoverageStore;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-istanbul-')));
  manifests = path.join(root, '.session', 'vitest-manifests');
  store = new CoverageStore();
});
afterEach(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

describe('toManifest', () => {
  it('keeps statements, branch arms and function lines (declaration line, end line)', () => {
    const m = toManifest(mathCoverage('/p/math.js', [1, 1, 0, 0], [1, 0], [0, 0]), '/p/math.js');
    expect(m.filePath).toBe('/p/math.js');
    expect(Object.keys(m.statements)).toHaveLength(4);
    expect(m.statements['1']).toEqual({ start: { line: 2, col: 2 }, end: { line: 2, col: 12 } });
    expect(m.branches['0']).toEqual({ type: 'if', line: 5, arms: 2 });
    expect(m.functions['1']).toEqual({ name: 'sub', start: { line: 4 }, end: { line: 7 } });
  });

  it('copes with what older providers leave out (no decl, no branch loc)', () => {
    const fc = mathCoverage('/p/a.js', [1, 1, 0, 0], [1, 0], [1, 0]);
    delete fc.fnMap['0'].decl;
    delete fc.branchMap['0'].loc;
    const m = toManifest(fc, '/p/a.js');
    expect(m.functions['0'].start.line).toBe(1);
    expect(m.branches['0'].line).toBe(5);
  });
});

describe('applyIstanbulCoverage', () => {
  const file = () => path.join(root, 'src', 'math.js');

  it('measures a file: percentages, counters, manifest on disk', () => {
    const r = applyIstanbulCoverage({ [file()]: mathCoverage(file(), [1, 1, 0, 0], [1, 0], [0, 0]) }, store, manifests, root);
    expect(r).toEqual({ measured: 1, excluded: 0 });
    const e = store.getEntry(file());
    expect(e?.state).toBe('measured');
    if (e?.state !== 'measured') { return; }
    expect(e.pct.statements).toMatchObject({ covered: 2, total: 4 });
    expect(e.pct.functions).toMatchObject({ covered: 1, total: 2 });
    expect(e.pct.branches).toMatchObject({ covered: 0, total: 2 });
    expect(fs.existsSync(e.manifestPath)).toBe(true);
  });

  it('merges a second run of the same file version (higher count wins)', () => {
    applyIstanbulCoverage({ [file()]: mathCoverage(file(), [1, 1, 0, 0], [1, 0], [0, 0]) }, store, manifests, root);
    applyIstanbulCoverage({ [file()]: mathCoverage(file(), [1, 0, 3, 3], [0, 2], [3, 0]) }, store, manifests, root);
    const e = store.getEntry(file());
    if (e?.state !== 'measured') { throw new Error('not measured'); }
    expect(e.counters.s).toEqual({ 0: 1, 1: 1, 2: 3, 3: 3 });
    expect(e.pct.statements.covered).toBe(4);
    expect(e.pct.functions.covered).toBe(2);
    expect(e.pct.branches.covered).toBe(1);
  });

  it('starts over when the file changed (different maps → new manifest)', () => {
    applyIstanbulCoverage({ [file()]: mathCoverage(file(), [1, 1, 1, 1], [1, 1], [1, 1]) }, store, manifests, root);
    const first = store.getEntry(file());
    const changed = mathCoverage(file(), [1, 0, 0, 0], [1, 0], [0, 0]);
    changed.statementMap['3'] = loc(9, 2);
    applyIstanbulCoverage({ [file()]: changed }, store, manifests, root);
    const e = store.getEntry(file());
    if (e?.state !== 'measured' || first?.state !== 'measured') { throw new Error('not measured'); }
    expect(e.manifestPath).not.toBe(first.manifestPath);
    expect(e.pct.statements.covered).toBe(1);
  });

  it('replaces a source-scan count (0 hits) with the measurement', () => {
    store.setCountedEntry(file(), { statements: 4, branches: 2, functions: 2, lines: 4 });
    applyIstanbulCoverage({ [file()]: mathCoverage(file(), [1, 1, 0, 0], [1, 0], [0, 0]) }, store, manifests, root);
    expect(store.getEntry(file())?.state).toBe('measured');
  });

  it('leaves out tests, configs, dependencies and top-level test / build folders', () => {
    const files = [
      'src/math.test.ts', 'vitest.config.ts', 'node_modules/x/index.js',
      'test/helpers.ts', '__tests__/setup.js', 'dist/index.js', 'coverage/lcov.js',
    ].map((f) => path.join(root, f));
    const map = Object.fromEntries(files.map((f) => [f, mathCoverage(f, [1, 1, 0, 0], [1, 0], [0, 0])]));
    expect(applyIstanbulCoverage(map, store, manifests, root)).toEqual({ measured: 0, excluded: files.length });
  });

  it('uses the entry key when the entry has no path', () => {
    const fc = mathCoverage('', [1, 1, 0, 0], [1, 0], [0, 0]);
    applyIstanbulCoverage({ [file()]: fc }, store, manifests, root);
    expect(store.getEntry(file())?.state).toBe('measured');
  });
});

describe('isExcludedFromCoverage', () => {
  it('matches folder rules with or without a leading separator, on both separators', () => {
    expect(isExcludedFromCoverage('test/helpers.ts')).toBe(true);
    expect(isExcludedFromCoverage('pkg\\__tests__\\a.js')).toBe(true);
    expect(isExcludedFromCoverage('/abs/dist/a.js')).toBe(true);
    expect(isExcludedFromCoverage('src/testing.ts')).toBe(false);
    expect(isExcludedFromCoverage('src/math.js')).toBe(false);
  });
});
