import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { combineWithEntry, mergeByLine } from '../src/coverage/coverageRules';
import { CoveragePct, Manifest } from '../src/coverage/types';

/** Phase 8: a source file loaded by Jest and Vitest tests keeps the lines either ran. */

const st = (line: number) => ({ start: { line, col: 0 }, end: { line, col: 10 } });
const pct = {} as CoveragePct;

/** Jest's instrumentation: one statement per line 1–4, `add` (line 1), `sub` (line 3), an if on line 4. */
const jestManifest: Manifest = {
  filePath: '/p/math.ts',
  statements: { a: st(1), b: st(2), c: st(3), d: st(4) },
  functions: { fa: { name: 'add', start: { line: 1 }, end: { line: 2 } }, fs: { name: 'sub', start: { line: 3 }, end: { line: 4 } } },
  branches: { ba: { type: 'if', line: 4, arms: 2 } },
};
/** Vitest (v8 → istanbul): other ids, same lines. */
const vitestManifest: Manifest = {
  filePath: '/p/math.ts',
  statements: { 0: st(1), 1: st(2), 2: st(3), 3: st(4) },
  functions: { 0: { name: 'add', start: { line: 1 }, end: { line: 2 } }, 1: { name: 'sub', start: { line: 3 }, end: { line: 4 } } },
  branches: { 0: { type: 'if', line: 4, arms: 2 } },
};

describe('coverage across frameworks', () => {
  it('mergeByLine: a line either framework ran is covered', () => {
    // Jest's tests called add only; Vitest's called sub, taking the if's first arm.
    const jest = { s: { a: 1, b: 1, c: 0, d: 0 }, f: { fa: 1, fs: 0 }, b: { ba: [0, 0] } };
    const vitest = { s: { 0: 0, 1: 0, 2: 3, 3: 3 }, f: { 0: 0, 1: 3 }, b: { 0: [3, 0] } };
    expect(mergeByLine(jestManifest, jest, vitestManifest, vitest)).toEqual({
      s: { 0: 1, 1: 1, 2: 3, 3: 3 },
      f: { 0: 1, 1: 3 },
      b: { 0: [3, 0] },
    });
  });

  it('mergeByLine: a function the other framework called covers its header and closing lines', () => {
    // v8 (Vitest): one statement per line of add (lines 1–3); Jest's babel: only the body (line 2).
    const v8: Manifest = {
      filePath: '/p/a.ts',
      statements: { 0: st(1), 1: st(2), 2: st(3) },
      functions: { 0: { name: 'add', start: { line: 1 }, end: { line: 3 } } },
      branches: {},
    };
    const babel: Manifest = {
      filePath: '/p/a.ts',
      statements: { a: st(2) },
      functions: { fa: { name: 'add', start: { line: 1 }, end: { line: 3 } } },
      branches: {},
    };
    // Jest called add, Vitest did not: the v8 entry gets all three lines.
    expect(mergeByLine(babel, { s: { a: 1 }, f: { fa: 1 }, b: {} }, v8, { s: { 0: 0, 1: 0, 2: 0 }, f: { 0: 0 }, b: {} }).s)
      .toEqual({ 0: 1, 1: 1, 2: 1 });
  });

  it('combineWithEntry: same manifest merges, a newer version of the same framework replaces, the other framework merges by line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr covmerge '));
    try {
      const jestPath = path.join(dir, 'ltr-manifests', 'h1.json');
      const vitestPath = path.join(dir, 'vitest-manifests', 'h2.json');
      for (const [p, m] of [[jestPath, jestManifest], [vitestPath, vitestManifest]] as const) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(m));
      }
      const jestEntry = { state: 'measured' as const, manifestPath: jestPath, counters: { s: { a: 1, b: 1, c: 0, d: 0 }, f: { fa: 1, fs: 0 }, b: { ba: [0, 0] } }, pct };
      const vitestCov = { s: { 0: 0, 1: 0, 2: 1, 3: 0 }, f: { 0: 0, 1: 1 }, b: { 0: [0, 0] } };

      expect(combineWithEntry(undefined, vitestPath, vitestManifest, vitestCov)).toBe(vitestCov);
      expect(combineWithEntry(jestEntry, jestPath, jestManifest, { s: { c: 2 }, f: {}, b: {} }).s).toEqual({ a: 1, b: 1, c: 2, d: 0 });
      const otherVersion = path.join(dir, 'ltr-manifests', 'h3.json');
      expect(combineWithEntry(jestEntry, otherVersion, jestManifest, vitestCov)).toBe(vitestCov);
      expect(combineWithEntry(jestEntry, vitestPath, vitestManifest, vitestCov).s).toEqual({ 0: 1, 1: 1, 2: 1, 3: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
