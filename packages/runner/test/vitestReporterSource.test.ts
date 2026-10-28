import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vitestReporterFile, VITEST_EVENTS_ENV } from '../src/framework/vitestReporter';

/**
 * The reporter is plain ESM written to disk and loaded by Vitest. These tests
 * load it in a separate node process and drive it with synthetic Vitest
 * objects (task trees, reporter hooks) — both the Vitest 3+ API and the
 * onTaskUpdate path of Vitest 1–2 — then read the events it wrote.
 */

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-reporter-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs `body` (ESM, with `Reporter` and `tree()` in scope) and returns the events written. */
function drive(body: string): Record<string, unknown>[] {
  const reporter = vitestReporterFile(dir);
  const events = path.join(dir, 'events.jsonl');
  const driver = path.join(dir, 'driver.mjs');
  fs.writeFileSync(driver, `
    import { pathToFileURL } from 'node:url';
    const { default: Reporter } = await import(pathToFileURL(${JSON.stringify(reporter)}).href);
    /** A file with suite "s" holding a failing test "t" and a passing test "ok". */
    function tree() {
      const file = { id: 'f', type: 'suite', name: 'a.test.ts', filepath: '/p/a.test.ts', result: { state: 'fail', startTime: 1000, duration: 50 } };
      const s = { id: 'f_0', type: 'suite', name: 's', file };
      const t = { id: 'f_0_0', type: 'test', name: 't', file, location: { line: 3, column: 5 },
        result: { state: 'fail', duration: 3.4, errors: [{ name: 'AssertionError', message: 'expected 1 to be 2', diff: '- 2\\n+ 1', stack: 'AssertionError: x\\n    at /p/a.test.ts:4:9' }] } };
      const ok = { id: 'f_0_1', type: 'test', name: 'ok', file, location: { line: 6, column: 5 }, result: { state: 'pass', duration: 1 } };
      s.tasks = [t, ok]; file.tasks = [s];
      const idMap = new Map([[file.id, file], [s.id, s], [t.id, t], [ok.id, ok]]);
      return { file, s, t, ok, idMap };
    }
    ${body}
  `);
  const r = spawnSync(process.execPath, [driver], { env: { ...process.env, [VITEST_EVENTS_ENV]: events }, encoding: 'utf8' });
  if (r.status !== 0) { throw new Error(r.stderr); }
  return fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

it('Vitest 3+: live events, a json-shaped result and failures before file-end, once', () => {
  const ev = drive(`
    const { file, t, idMap } = tree();
    const r = new Reporter();
    r.onInit({ version: '3.2.4', state: { idMap } });
    r.onTestModuleStart({ moduleId: file.filepath });
    r.onTestCaseReady({ name: 't', module: { moduleId: file.filepath } });
    r.onUserConsoleLog({ taskId: t.id, type: 'stdout', content: 'hi\\n' });
    r.onTestCaseResult({ name: 't', module: { moduleId: file.filepath } });
    r.onTaskUpdate([[file.id, { state: 'pass' }]]); // ignored on 3+
    r.onTestModuleEnd({ task: file });
    r.onTestRunEnd([{ task: file }]);
    r.onFinished([file]);
  `);
  expect(ev.map((e) => e.ev)).toEqual(['file-start', 'test-start', 'log', 'test-end', 'error', 'file-end']);
  expect(ev[2]).toEqual({ ev: 'log', file: '/p/a.test.ts', scope: 'test', names: ['s', 't'], type: 'stdout', content: 'hi\n' });
  expect(ev[4]).toMatchObject({ scope: 'test', names: ['s', 't'], errors: [{ name: 'AssertionError', message: 'expected 1 to be 2', diff: '- 2\n+ 1' }] });
  expect(ev[5]).toMatchObject({ file: '/p/a.test.ts', result: {
    name: '/p/a.test.ts', status: 'failed', startTime: 1000, endTime: 1050,
    assertionResults: [
      { ancestorTitles: ['s'], title: 't', fullName: 's t', status: 'failed', duration: 3.4, location: { line: 3, column: 5 } },
      { ancestorTitles: ['s'], title: 'ok', fullName: 's ok', status: 'passed' },
    ],
  } });
});

it('Vitest 1 – 2: the same events from onTaskUpdate', () => {
  const ev = drive(`
    const { file, t, idMap } = tree();
    const r = new Reporter();
    r.onInit({ version: '2.1.9', state: { idMap } });
    r.onTestModuleStart({ moduleId: file.filepath }); // not used before 3
    r.onTaskUpdate([[file.id, { state: 'run' }], [t.id, { state: 'run' }]]);
    r.onTaskUpdate([[t.id, { state: 'fail' }], [file.id, { state: 'fail' }]]);
    r.onFinished([file]);
  `);
  expect(ev.map((e) => e.ev)).toEqual(['file-start', 'test-start', 'test-end', 'error', 'file-end']);
  expect(ev[1]).toEqual({ ev: 'test-start', file: '/p/a.test.ts', name: 't' });
});

it('reports a file that never ended (crash) at run end, and a failing hook on its suite', () => {
  const ev = drive(`
    const { file, s, idMap } = tree();
    s.result = { state: 'fail', errors: [{ name: 'Error', message: 'setup broke', stack: 'Error: setup broke\\n    at /p/a.test.ts:2:9' }] };
    const r = new Reporter();
    r.onInit({ version: '5.0.5', state: { idMap } });
    r.onTestRunEnd([{ task: file }]);
  `);
  expect(ev.filter((e) => e.ev === 'error').map((e) => [e.scope, e.names])).toEqual([['suite', ['s']], ['test', ['s', 't']]]);
  expect(ev[ev.length - 1].ev).toBe('file-end');
});

it('Vitest 1: module-scope output tagged <file>:<line>:<col> goes to the file', () => {
  const ev = drive(`
    const r = new Reporter();
    r.onInit({ state: { idMap: new Map() }, config: { root: '/p' } });
    r.onUserConsoleLog({ taskId: 'src/a.test.ts:2:9', type: 'stdout', content: 'top\\n' });
  `);
  expect(ev).toEqual([{ ev: 'log', file: path.resolve('/p', 'src/a.test.ts'), scope: 'file', names: [], type: 'stdout', content: 'top\n' }]);
});

it('tags a type-check run of a file (typecheck.enabled: meta.typecheck) on file-end', () => {
  const ev = drive(`
    const { file, idMap } = tree();
    file.meta = { typecheck: true };
    const r = new Reporter();
    r.onInit({ version: '3.2.4', state: { idMap } });
    r.onTestModuleEnd({ task: file });
  `);
  expect(ev.find((e) => e.ev === 'file-end')).toMatchObject({ file: '/p/a.test.ts', typecheck: true });
});

it('a run of a file without type-check is not tagged', () => {
  const plain = drive(`
    const { file, idMap } = tree();
    const r = new Reporter();
    r.onInit({ version: '3.2.4', state: { idMap } });
    r.onTestModuleEnd({ task: file });
  `);
  expect(plain.find((e) => e.ev === 'file-end')).not.toHaveProperty('typecheck');
});
