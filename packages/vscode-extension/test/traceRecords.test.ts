import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecutionTraceStore } from '../src/store/ExecutionTraceStore';
import { applyTraceRecords, readTraceLines, workerTraceFiles } from '../src/session/traceRecords';

/** Trace records (T / H / F, docs/architecture.md → Session instrumentation protocol) → ExecutionTraceStore, shared by Jest and Vitest. */

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
