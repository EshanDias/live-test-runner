import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoverageStore, MeasuredFile } from '../src/coverage/CoverageStore';
import { FileCov, Manifest } from '../src/coverage/types';

/**
 * Coverage is the sum of each test file's latest run (its contribution):
 * a rerun replaces it, so coverage goes down as well as up.
 */

const SRC = '/p/src/math.js';
const OTHER = '/p/src/other.js';

/** Four statements on lines 1–4, one two-arm branch on line 2, two functions. */
function manifestFor(filePath: string): Manifest {
  return {
    filePath,
    statements: {
      0: { start: { line: 1, col: 0 }, end: { line: 1, col: 9 } },
      1: { start: { line: 2, col: 0 }, end: { line: 2, col: 9 } },
      2: { start: { line: 3, col: 0 }, end: { line: 3, col: 9 } },
      3: { start: { line: 4, col: 0 }, end: { line: 4, col: 9 } },
    },
    branches: { 0: { type: 'if', line: 2, arms: 2 } },
    functions: { 0: { name: 'a', start: { line: 1 }, end: { line: 2 } }, 1: { name: 'b', start: { line: 3 }, end: { line: 4 } } },
  };
}

const cov = (s: number[], b: number[] = [0, 0], f: number[] = [0, 0]): FileCov => ({
  s: Object.fromEntries(s.map((v, i) => [i, v])),
  b: { 0: b },
  f: Object.fromEntries(f.map((v, i) => [i, v])),
});

let dir: string;
let store: CoverageStore;
let manifests: Map<string, string>;

/** A manifest on disk for one version of a file (the store reads it back after a subtraction). */
function version(filePath: string, name: string): string {
  const key = `${filePath}#${name}`;
  let p = manifests.get(key);
  if (!p) {
    p = path.join(dir, 'manifests', `${manifests.size}.json`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(manifestFor(filePath)));
    manifests.set(key, p);
  }
  return p;
}

function measured(entries: Array<[string, FileCov, string?]>): Map<string, MeasuredFile> {
  return new Map(entries.map(([fp, c, v]) => [fp, { manifestPath: version(fp, v ?? 'v1'), manifest: manifestFor(fp), counters: c }]));
}

function covered(fp: string): number | undefined {
  const e = store.getEntry(fp);
  return e && e.state !== 'counted' ? e.pct.statements.covered : undefined;
}

function suite(withDir: boolean) {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-contrib-'));
    manifests = new Map();
    store = new CoverageStore();
    if (withDir) { store.setContributionDir(path.join(dir, 'contrib')); }
  });
  afterEach(() => { store.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('adds up the test files that cover a file', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.replaceContribution('/p/b.test.js', measured([[SRC, cov([1, 0, 1, 0])]]), 1);
    expect(covered(SRC)).toBe(3);
    const e = store.getEntry(SRC);
    if (e?.state !== 'measured') { throw new Error('not measured'); }
    expect(e.counters.s).toEqual({ 0: 2, 1: 1, 2: 1 });
  });

  it('a rerun that reaches less lowers the coverage (a test was deleted)', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 1, 1], [1, 1], [1, 1])]]), 1);
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0], [1, 0], [1, 0])]]), 2);
    const e = store.getEntry(SRC);
    if (e?.state !== 'measured') { throw new Error('not measured'); }
    expect(e.pct.statements.covered).toBe(2);
    expect(e.pct.branches.covered).toBe(1);
    expect(e.pct.functions.covered).toBe(1);
  });

  it('a deleted test file takes its coverage with it', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.replaceContribution('/p/b.test.js', measured([[SRC, cov([0, 0, 1, 0])], [OTHER, cov([1, 0, 0, 0])]]), 1);
    store.removeContribution('/p/b.test.js');
    expect(covered(SRC)).toBe(2);
    expect(store.getEntry(OTHER)).toBeUndefined();
  });

  it('a file no test reaches any more falls back to its source-scan count (0%)', () => {
    store.setCountedEntry(OTHER, { statements: 4, branches: 2, functions: 2, lines: 4 });
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])], [OTHER, cov([1, 1, 0, 0])]]), 1);
    expect(covered(OTHER)).toBe(2);
    // The test no longer calls into OTHER.
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 2);
    expect(store.getEntry(OTHER)).toEqual({ state: 'counted', statements: 4, branches: 2, functions: 2, lines: 4 });
  });

  it('a test file that now covers nothing (empty run) removes its contribution', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.replaceContribution('/p/a.test.js', new Map(), 2);
    expect(store.getEntry(SRC)).toBeUndefined();
  });

  it('a changed file is stale until its tests run on the new version; the totals say "updating"', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.replaceContribution('/p/b.test.js', measured([[SRC, cov([0, 0, 1, 0])]]), 1);
    store.markSourceChanged(SRC, 10);
    expect(store.getEntry(SRC)?.state).toBe('measured-stale');
    expect(store.getTotals().updating).toBe(1);
    expect(store.outdatedContributors().sort()).toEqual(['/p/a.test.js', '/p/b.test.js']);

    // a reran on the new version: only its numbers show, b is still outdated.
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 1], undefined, undefined), 'v2']]), 11);
    expect(store.getEntry(SRC)?.state).toBe('measured');
    expect(covered(SRC)).toBe(2);
    expect(store.outdatedContributors()).toEqual(['/p/b.test.js']);
    expect(store.getTotals().updating).toBeUndefined();

    // b reran too: both on v2, nothing outdated.
    store.replaceContribution('/p/b.test.js', measured([[SRC, cov([0, 1, 0, 0]), 'v2']]), 12);
    expect(covered(SRC)).toBe(3);
    expect(store.outdatedContributors()).toEqual([]);
  });

  it('a run that started before the change does not count as current', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 1);
    store.markSourceChanged(SRC, 10);
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 9);
    expect(store.getEntry(SRC)?.state).toBe('measured-stale');
    expect(store.outdatedContributors()).toEqual(['/p/a.test.js']);
  });

  it('a deleted source file leaves the totals and the file list', () => {
    store.setCountedEntry(OTHER, { statements: 4, branches: 2, functions: 2, lines: 4 });
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.removeSource(SRC);
    store.removeSource(OTHER);
    expect(store.getEntry(SRC)).toBeUndefined();
    expect(store.getFileRows()).toEqual([]);
    expect(store.getTotals().statements.total).toBe(0);
    // Rerunning the test file afterwards does not bring stale counters back twice.
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 2);
    expect(covered(SRC)).toBe(1);
  });

  it('a source-scan count never hides a measurement', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.setCountedEntry(SRC, { statements: 4, branches: 2, functions: 2, lines: 4 });
    expect(store.getEntry(SRC)?.state).toBe('measured');
  });

  it('says how many test files ran without coverage', () => {
    store.markUnmeasured('/p/a.test.js');
    expect(store.getTotals().unmeasuredTestFiles).toBe(1);
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 1);
    expect(store.getTotals().unmeasuredTestFiles).toBeUndefined();
  });

  it('a file another framework measured per batch (mixed project) shows the lines either one ran', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 1);
    const vitest = version(SRC, 'vitest');
    store.setMeasuredEntry(SRC, { manifestPath: vitest, counters: cov([0, 0, 1, 0]), pct: { statements: { covered: 1, total: 4, pct: 25 }, branches: { covered: 0, total: 2, pct: 0 }, functions: { covered: 0, total: 2, pct: 0 }, lines: { covered: 1, total: 4, pct: 25 } } });
    expect(covered(SRC)).toBe(2);
    // The Jest test file reran and reaches nothing now: only Vitest's line is left.
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([0, 0, 0, 0])]]), 2);
    expect(covered(SRC)).toBe(1);
  });

  it('clear() forgets everything', () => {
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 1, 0, 0])]]), 1);
    store.clear();
    expect(store.getEntry(SRC)).toBeUndefined();
    store.replaceContribution('/p/a.test.js', measured([[SRC, cov([1, 0, 0, 0])]]), 2);
    expect(covered(SRC)).toBe(1);
  });
}

describe('coverage contributions (in memory)', () => { suite(false); });
describe('coverage contributions (on disk)', () => { suite(true); });
