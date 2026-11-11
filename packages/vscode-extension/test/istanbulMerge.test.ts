import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// The reference: istanbul's own merge, as Jest's and Vitest's reports use it (dev dependency only).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const libCoverage = require('istanbul-lib-coverage');
import { CoverageStore } from '../src/coverage/CoverageStore';
import { calculate } from '../src/coverage/CoverageReport';
import { mergeIstanbul } from '../src/coverage/coverageRules';
import { IstanbulFileCoverage, measuredFiles, combineMeasured } from '../src/coverage/istanbulCoverage';

/**
 * Two measurements of one file with different maps (Vitest's v8 maps depend
 * on what each test file ran) merge as the framework's own report merges
 * them: istanbul-lib-coverage's FileCoverage.merge.
 */

const FILE = '/p/src/s.js';

type R = { start: { line: number; column: number }; end: { line: number; column: number } };
const r = (l1: number, c1: number, l2: number, c2: number): R => ({ start: { line: l1, column: c1 }, end: { line: l2, column: c2 } });

/** Vitest 3 / v8: the file as one test file saw it (both functions ran), and as another (only `first`). */
function bothRan(): IstanbulFileCoverage {
  return {
    path: FILE,
    statementMap: { 0: r(1, 0, 1, 30), 1: r(2, 0, 2, 25), 2: r(3, 0, 3, 18), 3: r(4, 0, 4, 1), 4: r(6, 0, 6, 26), 5: r(7, 0, 7, 19), 6: r(8, 0, 8, 1) },
    fnMap: { 0: { name: 'first', decl: r(2, 16, 2, 21), loc: r(2, 16, 4, 1) }, 1: { name: 'second', decl: r(6, 16, 6, 22), loc: r(6, 16, 8, 1) } },
    branchMap: { 0: { type: 'branch', loc: r(2, 16, 4, 1), locations: [r(2, 16, 4, 1)] } },
    s: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
    f: { 0: 1, 1: 1 },
    b: { 0: [1] },
  };
}
function firstRan(): IstanbulFileCoverage {
  return {
    ...bothRan(),
    s: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 0, 6: 0 },
    f: { 0: 1, 1: 0 },
    // A block v8 saw only here: another branch of the same file.
    branchMap: { 0: { type: 'branch', loc: r(1, 0, 8, 1), locations: [r(1, 0, 8, 1)] } },
    b: { 0: [1] },
  };
}

/** What the four numbers would be in the framework's merged report. */
function reference(...fcs: IstanbulFileCoverage[]) {
  const map = libCoverage.createCoverageMap({});
  for (const fc of fcs) { map.merge({ [fc.path]: JSON.parse(JSON.stringify(fc)) }); }
  const sum = map.fileCoverageFor(fcs[0].path).toSummary();
  const pick = (m: { covered: number; total: number }) => ({ covered: m.covered, total: m.total });
  return { statements: pick(sum.statements), branches: pick(sum.branches), functions: pick(sum.functions), lines: pick(sum.lines) };
}

const numbers = (pct: ReturnType<typeof calculate>) => ({
  statements: { covered: pct.statements.covered, total: pct.statements.total },
  branches: { covered: pct.branches.covered, total: pct.branches.total },
  functions: { covered: pct.functions.covered, total: pct.functions.total },
  lines: { covered: pct.lines.covered, total: pct.lines.total },
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-istanbul-merge-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const measured = (fc: IstanbulFileCoverage) => measuredFiles({ [fc.path]: fc }, path.join(dir, 'vitest-manifests'), '/p', () => true).files.get(FILE)!;

describe('mergeIstanbul', () => {
  it('two maps of one file: the numbers of istanbul\'s own merge (both branches counted)', () => {
    const a = measured(bothRan());
    const b = measured(firstRan());
    expect(a.manifestPath).not.toBe(b.manifestPath);
    const merged = mergeIstanbul(a.manifest, a.counters, b.manifest, b.counters)!;
    expect(numbers(calculate(merged.manifest, merged.counters))).toEqual(reference(bothRan(), firstRan()));
    expect(numbers(calculate(merged.manifest, merged.counters)).branches).toEqual({ covered: 2, total: 2 });
  });

  it('random maps: always the numbers of istanbul\'s own merge', () => {
    // mulberry32: an even spread in every bit (an LCG's low bits repeat).
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % n);
    };
    let contained = 0;
    const range = () => { const l1 = 1 + rnd(12); const l2 = l1 + rnd(4); const c1 = rnd(8); return r(l1, c1, l2, l2 === l1 ? c1 + 1 + rnd(8) : rnd(10)); };
    const fileCov = (): IstanbulFileCoverage => {
      const fc: IstanbulFileCoverage = { path: FILE, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
      for (let i = 0, n = 1 + rnd(8); i < n; i++) { fc.statementMap[i] = range(); fc.s[i] = rnd(3); }
      for (let i = 0, n = rnd(4); i < n; i++) { const loc = range(); fc.fnMap[i] = { name: `f${i}`, decl: loc, loc }; fc.f[i] = rnd(2); }
      for (let i = 0, n = rnd(4); i < n; i++) { const loc = range(); fc.branchMap[i] = { type: 'if', loc, locations: [loc, range()] }; fc.b[i] = [rnd(2), rnd(2)]; }
      return fc;
    };
    for (let round = 0; round < 300; round++) {
      const x = fileCov();
      const y = fileCov();
      const a = measured(x);
      const b = measured(y);
      const merged = mergeIstanbul(a.manifest, a.counters, b.manifest, b.counters)!;
      expect({ round, ...numbers(calculate(merged.manifest, merged.counters)) }).toEqual({ round, ...reference(x, y) });
      if (Object.keys(y.statementMap).some((id) => y.s[id] === 0 && Object.values(x.statementMap).some((o) => o.start.line < y.statementMap[id].start.line && o.end.line > y.statementMap[id].end.line))) { contained++; }
    }
    // The cases the containment rule decides came up.
    expect(contained).toBeGreaterThan(10);
  });

  it('an item only one side has, inside a covered item of the other: covered (istanbul\'s nearest container)', () => {
    const outer: IstanbulFileCoverage = { path: FILE, statementMap: { 0: r(1, 0, 5, 1) }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} };
    const inner: IstanbulFileCoverage = { path: FILE, statementMap: { 0: r(1, 0, 5, 1), 1: r(2, 2, 2, 9) }, fnMap: {}, branchMap: {}, s: { 0: 0, 1: 0 }, f: {}, b: {} };
    const a = measured(outer);
    const b = measured(inner);
    const merged = mergeIstanbul(a.manifest, a.counters, b.manifest, b.counters)!;
    expect(reference(outer, inner).statements).toEqual({ covered: 2, total: 2 });
    expect(numbers(calculate(merged.manifest, merged.counters)).statements).toEqual({ covered: 2, total: 2 });
  });

  it('Jest\'s own manifests (no istanbul locations) are left to the by-line merge', () => {
    const a = measured(bothRan());
    const { locs: _, ...plain } = a.manifest;
    expect(mergeIstanbul(plain, a.counters, a.manifest, a.counters)).toBeUndefined();
  });

  it('combineMeasured: one test file measured twice in a run (two maps) keeps both, on disk for the gutter', () => {
    const c = combineMeasured(measured(bothRan()), measured(firstRan()));
    expect(numbers(calculate(c.manifest, c.counters))).toEqual(reference(bothRan(), firstRan()));
    expect(JSON.parse(fs.readFileSync(c.manifestPath, 'utf8'))).toEqual(c.manifest);
  });
});

describe('CoverageStore: test files whose maps of a file differ', () => {
  it('shows the framework\'s merged numbers, and one test file alone once the other covers nothing', () => {
    const store = new CoverageStore();
    store.setContributionDir(path.join(dir, 'contrib'));
    store.replaceContribution('/p/src/s1.test.js', new Map([[FILE, measured(bothRan())]]), 1);
    store.replaceContribution('/p/src/s2.test.js', new Map([[FILE, measured(firstRan())]]), 1);
    const both = store.getEntry(FILE);
    expect(both?.state).toBe('measured');
    expect(both && 'pct' in both && numbers(both.pct)).toEqual(reference(bothRan(), firstRan()));
    // The gutter / hover read the merged manifest.
    expect(both && 'manifestPath' in both && fs.existsSync(both.manifestPath)).toBe(true);

    store.replaceContribution('/p/src/s1.test.js', new Map(), 2);
    const one = store.getEntry(FILE);
    expect(one && 'pct' in one && numbers(one.pct)).toEqual(reference(firstRan()));
  });
});
