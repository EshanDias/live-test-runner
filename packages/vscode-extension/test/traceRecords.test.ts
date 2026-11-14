import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionTraceStore } from '../src/store/ExecutionTraceStore';
import { applyDependencyFiles, applyTraceRecords, readTraceLines, workerTraceFiles } from '../src/session/traceRecords';

/** Trace records (T / H / F, docs/development/architecture.md → Session instrumentation protocol) → ExecutionTraceStore, shared by Jest and Vitest. */

const TF = path.resolve('/p/src/cart.test.ts');
const PRICE = path.resolve('/p/src/price.ts');
const FORMAT = path.resolve('/p/src/format.js');
const SETUP = path.resolve('/p/src/setup.ts');
const id = (p: string) => p;

const lines = [
  { type: 'F', tf: TF },
  { type: 'H', tf: TF, hk: 'file', fh: { [PRICE]: [1, 9], [FORMAT]: [1] } },
  { type: 'H', tf: TF, hk: 'hook', fh: { [SETUP]: [3] } },
  { type: 'T', tf: TF, tn: 'cart totals', fh: { [PRICE]: [2, 3, 4], [TF]: [7] } },
  { type: 'T', tf: TF, tn: 'cart formats', fh: { [FORMAT]: [2] } },
  // a retry of the same test: merged, not replaced
  { type: 'T', tf: TF, tn: 'cart totals', fh: { [PRICE]: [5] } },
].map((r) => JSON.stringify(r));

it('indexes covered lines, line → tests and source → tests', () => {
  const store = new ExecutionTraceStore();
  const summary = applyTraceRecords([...lines, 'not json'], store, id);
  expect(summary).toEqual({ tests: 3, files: 1, seen: new Set([TF]) });
  expect([...store.getCoveredLines(PRICE)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 9]);
  expect(store.getTestsForLine(PRICE, 3).map((e) => e.fullName)).toEqual(['cart totals']);
  expect(store.getTestsForLine(PRICE, 5).map((e) => e.fullName)).toEqual(['cart totals']);
  expect(store.getTestsForLine(FORMAT, 2).map((e) => e.fullName)).toEqual(['cart formats']);
  // the test file's own lines are not "covering"
  expect(store.getTestsForLine(TF, 7)).toEqual([]);
  // price.ts: only "totals" ran it (module load does not count); format.js: only "formats"
  const cases = (src: string) => Object.values(store.getSuiteInfo(src, TF)).flatMap((s) => s.testCases).sort();
  expect(cases(PRICE)).toEqual(['cart totals']);
  expect(cases(FORMAT)).toEqual(['cart formats']);
  // a beforeAll / afterAll hook's file counts for every test of the file
  expect(cases(SETUP)).toEqual(['cart formats', 'cart totals']);
  expect(store.getAffectedTestFiles(PRICE)).toEqual([TF]);
});

it('maps test-file paths to the caller\'s keys', () => {
  const store = new ExecutionTraceStore();
  const key = path.resolve('/editor/cart.test.ts');
  const summary = applyTraceRecords(lines, store, () => key);
  expect(summary.seen).toEqual(new Set([key]));
  expect(store.getAffectedTestFiles(PRICE)).toEqual([key]);
});

it('reads every worker\'s trace file of a batch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-trace-'));
  try {
    const base = path.join(dir, 'ltr-vtrace-v1.jsonl');
    fs.writeFileSync(`${base}.100-0`, `${lines[0]}\n${lines[3]}\n`);
    fs.writeFileSync(`${base}.101-2`, `${lines[4]}\n\n`);
    fs.writeFileSync(path.join(dir, 'ltr-vtrace-v2.jsonl.100-0'), 'other batch');
    const files = workerTraceFiles(base).sort();
    expect(files.map((f) => path.basename(f))).toEqual(['ltr-vtrace-v1.jsonl.100-0', 'ltr-vtrace-v1.jsonl.101-2']);
    expect(readTraceLines([...files, path.join(dir, 'missing')])).toHaveLength(3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('module graph (Vitest): any file a test loads', () => {
  const p = (f: string) => path.resolve('/p/src', f);

  it('test files that reach a file through its importers — HTML templates, ?raw files, any type', () => {
    const store = new ExecutionTraceStore();
    store.addImporters(p('card.html'), [p('card.ts')]);       // a plugin read it (addWatchFile)
    store.addImporters(p('card.ts'), [p('card.test.ts'), p('page.ts')]);
    store.addImporters(p('page.ts'), [p('page.test.ts'), p('card.ts')]); // a cycle
    store.addImporters(p('banner.html'), [p('banner.test.ts')]); // ?raw import
    const isTest = (f: string) => /\.test\.ts$/.test(f);
    expect(store.isLoaded(p('card.html'))).toBe(true);
    expect(store.isLoaded(p('README.md'))).toBe(false);
    expect(store.getDependentTestFiles(p('card.html'), isTest).sort()).toEqual([p('card.test.ts'), p('page.test.ts')]);
    expect(store.getDependentTestFiles(p('banner.html'), isTest)).toEqual([p('banner.test.ts')]);
    expect(store.getDependentTestFiles(p('nothing.ts'), isTest)).toEqual([]);
    store.clearAll();
    expect(store.isLoaded(p('card.html'))).toBe(false);
  });

  it('reads the files the plugin wrote, merging batches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-deps-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ importers: { [p('card.html')]: [p('card.ts')] } }));
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ importers: { [p('card.html')]: [p('other.ts')], [p('x.ts')]: [] } }));
      fs.writeFileSync(path.join(dir, 'c.json'), 'not json');
      const store = new ExecutionTraceStore();
      expect(applyDependencyFiles(['a.json', 'b.json', 'c.json', 'missing.json'].map((f) => path.join(dir, f)), store)).toBe(3);
      const key = (f: string) => f.replace(/^[A-Z]:/, (m) => m.toLowerCase());
      expect(store.getDependentTestFiles(key(p('card.html')), () => true).sort()).toEqual([key(p('card.ts')), key(p('other.ts'))].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a rerun replaces a test file\'s entries', () => {
  const OTHER = path.resolve('/p/src/other.test.ts');
  const rec = (tf: string, tn: string, fh: Record<string, number[]>) => JSON.stringify({ type: 'T', tf, tn, fh });

  it('a test removed from the file leaves the index; other test files stay', () => {
    const store = new ExecutionTraceStore();
    applyTraceRecords([rec(TF, 'a', { [PRICE]: [2] }), rec(TF, 'b', { [PRICE]: [3] }), rec(OTHER, 'c', { [PRICE]: [3] })], store, id);
    // TF reran with only "a".
    applyTraceRecords([rec(TF, 'a', { [PRICE]: [2] })], store, id, [TF]);
    expect(store.getTestsForLine(PRICE, 2).map((e) => e.fullName)).toEqual(['a']);
    expect(store.getTestsForLine(PRICE, 3).map((e) => e.fullName)).toEqual(['c']);
    expect(Object.values(store.getSuiteInfo(PRICE, TF)).flatMap((s) => s.testCases)).toEqual(['a']);
  });

  it('a test file that ran but reached nothing is forgotten', () => {
    const store = new ExecutionTraceStore();
    applyTraceRecords([rec(TF, 'a', { [PRICE]: [2] })], store, id);
    applyTraceRecords([], store, id, [TF]);
    expect(store.getTestsForLine(PRICE, 2)).toEqual([]);
    expect(store.getAffectedTestFiles(PRICE)).toEqual([]);
  });

  it('a deleted folder forgets the test files under it', () => {
    const store = new ExecutionTraceStore();
    applyTraceRecords([rec(TF, 'a', { [PRICE]: [2] }), rec(OTHER, 'c', { [PRICE]: [3] })], store, id);
    store.forgetTestFiles(store.testFilesUnder(path.dirname(TF), path.sep));
    expect(store.getAffectedTestFiles(PRICE)).toEqual([]);
  });
});

it('two test files with a test of the same name on the same line are both listed; forgetting one keeps the other', () => {
  const store = new ExecutionTraceStore();
  const OTHER = path.resolve('/p/src/other.test.ts');
  const rec = (tf: string) => JSON.stringify({ type: 'T', tf, tn: 'renders', fh: { [PRICE]: [3] } });
  applyTraceRecords([rec(TF)], store, id);
  applyTraceRecords([rec(OTHER)], store, id);
  expect(store.getTestsForLine(PRICE, 3).map((e) => e.testFileId).sort()).toEqual([OTHER, TF].sort());
  expect(store.getAffectedTestFiles(PRICE).sort()).toEqual([OTHER, TF].sort());
  // TF reruns and no longer reaches price.ts: only OTHER is left
  applyTraceRecords([], store, id, [TF]);
  expect(store.getTestsForLine(PRICE, 3)).toEqual([{ testFileId: OTHER, fullName: 'renders' }]);
  expect(store.getAffectedTestFiles(PRICE)).toEqual([OTHER]);
});

it('a batch costs the same however many test files already cover a shared source file', () => {
  // Learnt from Sentry (2,500 test files sharing components): each batch scanned every earlier entry of a shared file.
  const store = new ExecutionTraceStore();
  const shared = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [path.resolve(`/p/src/shared${i}.tsx`), Array.from({ length: 30 }, (_, l) => l + 1)]));
  const batch = (b: number) => Array.from({ length: 49 * 5 }, (_, i) =>
    JSON.stringify({ type: 'T', tf: path.resolve(`/p/src/t${b}-${Math.floor(i / 5)}.test.tsx`), tn: `s > t${i % 5}`, fh: shared }));
  const time = (b: number) => { const t0 = process.hrtime.bigint(); applyTraceRecords(batch(b), store, id); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const first = Math.max(time(0), time(1));
  for (let b = 2; b < 20; b++) { time(b); }
  const late = Math.min(time(20), time(21));
  expect(store.getTestsForLine(path.resolve('/p/src/shared0.tsx'), 1)).toHaveLength(22 * 49 * 5);
  expect(late).toBeLessThan(first * 4);
});
