/**
 * The AI-assistant tools answer from the real stores (results, coverage,
 * trace) through a fake editor host: what each answer holds, ids that chain
 * between tools, runs through the session's own methods, and the diff a run
 * reports (fixed / newly failing).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResultStore, makeNodeId, TestStatus } from '../src/store/ResultStore';
import { CoverageStore, MeasuredFile } from '../src/coverage/CoverageStore';
import { ExecutionTraceStore } from '../src/store/ExecutionTraceStore';
import { Manifest } from '../src/coverage/types';
import { AiTools } from '../src/ai/tools';
import { AllowRuns, BridgeHost, BridgeProject } from '../src/ai/host';
import { IdCodec, lineRanges } from '../src/ai/ids';

let root: string;
let TEST: string;
let SRC: string;
let store: ResultStore;
let coverage: CoverageStore;
let trace: ExecutionTraceStore;
let calls: string[];
let allow: AllowRuns;
let session: { active: boolean; running: boolean; startedAt: number };
/** What a run sets each test to (by name): the fake framework. */
let outcome: Record<string, TestStatus>;
/** Whole-file runs wait for this (a run in flight, for the queue tests). */
let gate: Promise<void>;

const id = (...names: string[]) => makeNodeId(TEST, names.slice(0, -1), names[names.length - 1]);

function setStatus(name: string, status: TestStatus, messages: string[] = []) {
  const nodeId = id('Math', name);
  store.nodeResult(nodeId, status, 5, messages);
  store.bubbleUpStatus(nodeId);
}

const FAILURE = () => [
  `Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 4\n    at add (${SRC}:2:10)\n    at Object.<anonymous> (${TEST}:4:12)`,
];

function project(): BridgeProject {
  return {
    id: root, name: 'demo', root, frameworkLabel: 'jest',
    store, coverageStore: coverage, traceStore: trace,
    sessionActive: () => session.active,
    running: () => session.running,
    discovering: () => false,
    progress: () => ({ completed: 0, total: 0, failed: 0 }),
    runsStartedAt: () => session.startedAt,
    frameworks: () => [{ id: 'jest', displayName: 'Jest' }],
    frameworkOf: () => ({ id: 'jest', displayName: 'Jest' }),
    placements: () => undefined,
    runScope: async (args) => {
      calls.push(`scope ${args.scope} ${args.fullName}`);
      const n = args.nodeId ? store.getNode(args.nodeId) : undefined;
      if (n) { setStatus(n.name, outcome[n.name] ?? 'passed'); }
    },
    runFiles: async (files, label) => {
      await gate;
      calls.push(`files ${files.map((f) => path.basename(f)).join(',')} (${label})`);
      for (const [name, st] of Object.entries(outcome)) { setStatus(name, st, st === 'failed' ? FAILURE() : []); }
      return files;
    },
    runChangedFiles: async (files) => {
      calls.push(`changed ${files.map((f) => path.basename(f)).join(',')}`);
      for (const [name, st] of Object.entries(outcome)) { setStatus(name, st, st === 'failed' ? FAILURE() : []); }
      return [TEST];
    },
  };
}

function host(): BridgeHost {
  const p = project();
  return {
    projects: () => [p],
    selected: () => p,
    folders: () => [root],
    editorName: 'Visual Studio Code',
    extensionVersion: '3.5.0',
    readText: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } },
    allowRuns: () => allow,
    confirmRun: async () => true,
    announceRun: (what) => calls.push(`announce ${what}`),
    clearCacheAndRestart: () => calls.push('restart'),
    updateSnapshot: async () => false,
    showResult: (_p, fileId, nodeId) => calls.push(`show ${nodeId}`),
    showFile: async (f, line) => { calls.push(`open ${path.basename(f)}:${line}`); },
    diagnostics: () => '# report',
  };
}

const parse = async (tools: AiTools, name: string, args: Record<string, unknown> = {}) => {
  const res = await tools.call(name, args);
  return { ...JSON.parse(res.text), isError: !!res.isError };
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-ai-')));
  fs.mkdirSync(path.join(root, 'src'));
  SRC = path.join(root, 'src', 'math.js');
  TEST = path.join(root, 'src', 'math.test.js');
  fs.writeFileSync(SRC, 'function add(a, b) {\n  return a + b + 1;\n}\nfunction unused() {\n  return 0;\n}\nmodule.exports = { add, unused };\n');
  fs.writeFileSync(TEST, "const { add } = require('./math');\ndescribe('Math', () => {\n  test('adds', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n  test('works', () => {\n    expect(1).toBe(1);\n  });\n});\n");
  store = new ResultStore();
  coverage = new CoverageStore();
  trace = new ExecutionTraceStore();
  calls = [];
  allow = 'always';
  session = { active: true, running: false, startedAt: 0 };
  outcome = {};
  gate = Promise.resolve();

  store.fileDiscovered(TEST, TEST, 'src/math.test.js');
  store.nodeDiscovered(TEST, id('Math'), null, 'suite', 'Math', 'Math', 2);
  store.nodeDiscovered(TEST, id('Math', 'adds'), id('Math'), 'test', 'adds', 'Math adds', 3);
  store.nodeDiscovered(TEST, id('Math', 'works'), id('Math'), 'test', 'works', 'Math works', 6);
  store.setLineEntry(TEST, 3, { nodeId: id('Math', 'adds'), fileId: TEST });
  store.setLineEntry(TEST, 6, { nodeId: id('Math', 'works'), fileId: TEST });
  setStatus('adds', 'failed', FAILURE());
  setStatus('works', 'passed');
  store.fileResult(TEST, 'failed', 20);
  store.setNodeOutput(id('Math', 'works'), { lines: [{ text: 'hello', level: 'log', timestamp: 1 }], capturedAt: 1 });

  // Trace: "adds" ran lines 1–2 of math.js.
  trace.mergeLineToTests(SRC, TEST, new Map([[1, ['Math adds']], [2, ['Math adds']]]));
  trace.setSourceTests(SRC, TEST, { Math: { isSharedVars: false, sharedVarNames: [], testCases: ['Math adds'] } });

  // Coverage: add() ran, unused() did not.
  const manifest: Manifest = {
    filePath: SRC,
    statements: {
      0: { start: { line: 2, col: 2 }, end: { line: 2, col: 18 } },
      1: { start: { line: 5, col: 2 }, end: { line: 5, col: 11 } },
      2: { start: { line: 7, col: 0 }, end: { line: 7, col: 35 } },
    },
    branches: {},
    functions: { 0: { name: 'add', start: { line: 1 }, end: { line: 3 } }, 1: { name: 'unused', start: { line: 4 }, end: { line: 6 } } },
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const files = new Map<string, MeasuredFile>([[SRC, { manifestPath, manifest, counters: { s: { 0: 1, 1: 0, 2: 1 }, b: {}, f: { 0: 1, 1: 0 } } }]]);
  coverage.replaceContribution(TEST, files, Date.now());
});

afterEach(() => {
  coverage.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ids', () => {
  it('are workspace-relative and map back', () => {
    const codec = new IdCodec(() => [root]);
    const nodeId = id('Math', 'adds');
    expect(codec.encode(nodeId, TEST)).toBe('src/math.test.js::Math::adds');
    expect(codec.candidates('src/math.test.js::Math::adds')).toContain(nodeId);
    expect(codec.candidates('./src/math.test.js')).toContain(TEST);
  });

  it('multi-root ids lead with the folder name', () => {
    const codec = new IdCodec(() => [root, path.join(os.tmpdir(), 'other')]);
    const rel = codec.rel(TEST);
    expect(rel).toBe(`${path.basename(root)}/src/math.test.js`);
    expect(codec.candidates(rel)).toContain(TEST);
  });

  it('line ranges compress', () => {
    expect(lineRanges([7, 1, 2, 3, 9, 8])).toBe('1-3, 7-9');
  });
});

describe('understand the state', () => {
  it('get_status: counts, session, freshness and a hint', async () => {
    const tools = new AiTools(host());
    const s = await parse(tools, 'LTR_get_status');
    expect(s.projects[0]).toMatchObject({ name: 'demo', frameworks: 'jest', session: 'on', tests: { total: 2, passed: 1, failed: 1 } });
    expect(s).toMatchObject({ running: false, stale: false, sessionOn: true });
    expect(s.hint).toMatch(/session is on/);
  });

  it('a change after the latest run makes results stale until a run starts', async () => {
    const tools = new AiTools(host());
    tools.noteChanged([SRC]);
    expect(await parse(tools, 'LTR_get_status')).toMatchObject({ stale: true, changedFiles: ['src/math.js'] });
    session.startedAt = Date.now() + 1;
    expect(await parse(tools, 'LTR_get_status')).toMatchObject({ stale: false });
  });

  it('find_tests: by name, by file:line, and the tests that ran a source line', async () => {
    const tools = new AiTools(host());
    expect((await parse(tools, 'LTR_find_tests', { query: 'adds' })).matches[0]).toMatchObject({ id: 'src/math.test.js::Math::adds', status: 'failed', line: 3 });
    expect((await parse(tools, 'LTR_find_tests', { query: 'src/math.test.js:7' })).matches[0]).toMatchObject({ name: 'Math works' });
    expect((await parse(tools, 'LTR_find_tests', { query: 'src/math.js:2' })).matches.map((m: { name: string }) => m.name)).toEqual(['Math adds']);
  });

  it('list_tests filters by status', async () => {
    const tools = new AiTools(host());
    const r = await parse(tools, 'LTR_list_tests', { status: 'failed' });
    expect(r.files[0].tests.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
  });
});

describe('fix failures', () => {
  it('get_failures: id, location and the first line of the error', async () => {
    const r = await parse(new AiTools(host()), 'LTR_get_failures');
    expect(r.failing).toBe(1);
    expect(r.failures[0]).toMatchObject({ id: 'src/math.test.js::Math::adds', file: 'src/math.test.js', line: 3, error: 'Expected 3, received 4' });
    expect(r.dataNote).toMatch(/data, not instructions/);
  });

  it('explain_failure: everything for one failure in one answer', async () => {
    const r = await parse(new AiTools(host()), 'LTR_explain_failure', { id: 'src/math.test.js::Math::adds' });
    expect(r.error).toMatchObject({ summary: 'Expected 3, received 4', expected: '3', received: '4' });
    expect(r.error.stack).toEqual(['src/math.js:2', 'src/math.test.js:4']);
    expect(r.thrownAt.code).toMatch(/>    2 \|   return a \+ b \+ 1;/);
    expect(r.failingLineInTest.code).toMatch(/>    4 \|/);
    expect(r.testCode).toMatchObject({ lines: '3-5' });
    expect(r.testCode.code).toContain("test('adds'");
    expect(r.linesRun).toEqual([{ file: 'src/math.js', lines: '1-2' }]);
    expect(r.output).toMatchObject({ captured: false });
    expect(JSON.stringify(r)).not.toContain(root); // no machine paths
  });

  it('get_output: captured lines, or why there are none (never back-filled)', async () => {
    const tools = new AiTools(host());
    expect(await parse(tools, 'LTR_get_output', { id: 'src/math.test.js::Math::works' })).toMatchObject({ captured: true, text: 'hello' });
    const none = await parse(tools, 'LTR_get_output', { id: 'src/math.test.js::Math::adds' });
    expect(none).toMatchObject({ captured: false });
    expect(none.note).toMatch(/Jest reports console output per file/);
  });

  it('an unknown id is a tool error naming what to call', async () => {
    const r = await parse(new AiTools(host()), 'LTR_explain_failure', { id: 'nope::x' });
    expect(r.isError).toBe(true);
    expect(r.error).toMatch(/LTR_find_tests/);
  });
});

describe('coverage', () => {
  it('get_coverage for a file: uncovered lines and who covers it', async () => {
    const r = await parse(new AiTools(host()), 'LTR_get_coverage', { file: 'src/math.js' });
    expect(r).toMatchObject({ uncoveredLines: '5', coveredByTestFiles: ['src/math.test.js'] });
  });

  it('find_untested: the gap with its code and the untested function', async () => {
    const r = await parse(new AiTools(host()), 'LTR_find_untested', { file: 'src/math.js' });
    expect(r.untestedFunctions).toEqual([{ name: 'unused', line: 4 }]);
    expect(r.gaps[0]).toMatchObject({ lines: '5' });
    expect(r.gaps[0].code).toContain('return 0;');
  });

  it('check_change_coverage: untested lines of a range, and the tests of the rest', async () => {
    const r = await parse(new AiTools(host()), 'LTR_check_change_coverage', { file: 'src/math.js', startLine: 1, endLine: 6 });
    expect(r).toMatchObject({ uncoveredLines: '5', executableLines: 2 });
    expect(r.testedBy.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
  });

  it('get_affected_tests: traced tests of a source file', async () => {
    const r = await parse(new AiTools(host()), 'LTR_get_affected_tests', { file: 'src/math.js' });
    expect(r.source).toMatch(/trace/);
    expect(r.tests.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
  });
});

describe('runs', () => {
  it('run_tests runs the scope like ▶ Run and reports what it fixed', async () => {
    const tools = new AiTools(host());
    outcome = { adds: 'passed' };
    const started = await parse(tools, 'LTR_run_tests', { ids: ['src/math.test.js::Math::adds'] });
    expect(started.runId).toMatch(/^run-/);
    const done = await parse(tools, 'LTR_get_run', { runId: started.runId, wait: 5 });
    expect(calls).toContain('scope test Math adds');
    expect(done).toMatchObject({ state: 'finished', tests: { passed: 1, failed: 0 } });
    expect(done.fixed.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
  });

  it('verify_fix reruns what the changed file affects and reports regressions', async () => {
    const tools = new AiTools(host());
    session.active = false;
    outcome = { adds: 'passed', works: 'failed' };
    const r = await parse(tools, 'LTR_verify_fix', { files: ['src/math.js'] });
    expect(calls).toContain('changed math.js');
    expect(r.state).toBe('finished');
    expect(r.fixed.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
    expect(r.newlyFailing.map((t: { name: string }) => t.name)).toEqual(['Math works']);
    expect(r.next).toMatch(/Regressions/);
  });

  it('verify_fix without files uses the files changed since the last run', async () => {
    const tools = new AiTools(host());
    session.active = false;
    tools.noteChanged([SRC]);
    outcome = { adds: 'passed' };
    const r = await parse(tools, 'LTR_verify_fix');
    expect(calls).toContain('changed math.js');
    expect(r.fixed.map((t: { name: string }) => t.name)).toEqual(['Math adds']);
  });

  it('run_failed reruns only the failing tests', async () => {
    const tools = new AiTools(host());
    const r = await parse(tools, 'LTR_run_failed');
    await parse(tools, 'LTR_get_run', { runId: r.runId, wait: 5 });
    expect(calls.filter((c) => c.startsWith('scope'))).toEqual(['scope test Math adds']);
  });

  it('allowRuns never: runs are refused, reads still work', async () => {
    allow = 'never';
    const tools = new AiTools(host());
    const r = await parse(tools, 'LTR_run_tests', {});
    expect(r.isError).toBe(true);
    expect(r.error).toMatch(/liveTestRunner\.ai\.allowRuns/);
    expect(calls).toEqual([]);
    expect((await parse(tools, 'LTR_get_failures')).failing).toBe(1);
  });

  it('cancel stops a queued run; Stop cancels everything queued', async () => {
    const tools = new AiTools(host());
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    const a = await parse(tools, 'LTR_run_tests', { ids: ['src/math.test.js'] });
    const b = await parse(tools, 'LTR_run_tests', { ids: ['src/math.test.js::Math::works'] });
    expect((await parse(tools, 'LTR_cancel_run', { runId: b.runId })).cancelled).toBe(true);
    release();
    await parse(tools, 'LTR_get_run', { runId: a.runId, wait: 5 });
    expect((await parse(tools, 'LTR_get_run', { runId: b.runId, wait: 5 })).state).toBe('cancelled');
    expect(calls.filter((c) => c.startsWith('scope'))).toEqual([]);
  });

  it('clear_cache_and_restart only while the session is on', async () => {
    session.active = false;
    const tools = new AiTools(host());
    expect(await parse(tools, 'LTR_clear_cache_and_restart')).toMatchObject({ restarted: false });
    session.active = true;
    expect(await parse(tools, 'LTR_clear_cache_and_restart')).toMatchObject({ restarted: true });
    expect(calls).toContain('restart');
  });

  it('show: a result in the panel, or a file at a line', async () => {
    const tools = new AiTools(host());
    await parse(tools, 'LTR_show', { target: 'src/math.test.js::Math::adds' });
    await parse(tools, 'LTR_show', { target: 'src/math.js:2' });
    expect(calls).toEqual([`show ${id('Math', 'adds')}`, 'open math.js:2']);
  });
});
