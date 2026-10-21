import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestRunner } from '../src/VitestRunner';
import { Executor } from '../src/execution/Executor';
import { VITEST_EVENTS_ENV, toConsoleEntry } from '../src/framework/vitestReporter';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';

/** Console output from the reporter's events file is attached per file, with its scope. */

let root: string;
beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(undefined));
beforeEach(() => {
  _resetProjectRoots();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vconsole-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '5' } }));
  const dir = path.join(root, 'node_modules', 'vitest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vitest', version: '5.0.5', bin: { vitest: './vitest.mjs' } }));
  fs.writeFileSync(path.join(dir, 'vitest.mjs'), '');
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('maps reporter events to console entries with scope and full name', () => {
  expect(toConsoleEntry({ ev: 'log', file: '/p/a.test.ts', scope: 'test', names: ['Outer', 'adds'], type: 'stdout', content: 'hi\n' }))
    .toEqual({ message: 'hi', type: 'log', origin: 'Outer > adds', scope: 'test', scopeName: 'Outer adds' });
  expect(toConsoleEntry({ ev: 'log', file: '/p/a.test.ts', scope: 'file', names: [], type: 'stderr', content: 'boom' }))
    .toEqual({ message: 'boom', type: 'error', origin: '', scope: 'file' });
});

it('attaches the events of a run to its files and cleans up the events file', async () => {
  const testFile = path.join(root, 'a.test.ts');
  let eventsFile = '';
  jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd) => {
    eventsFile = cmd.extraEnv?.[VITEST_EVENTS_ENV] ?? '';
    expect(cmd.forwardStdout).toBe(true);
    fs.writeFileSync(eventsFile, [
      { ev: 'log', file: testFile, scope: 'file', names: [], type: 'stdout', content: 'module\n' },
      { ev: 'log', file: testFile, scope: 'test', names: ['s', 't'], type: 'stdout', content: 'in test\n' },
      { ev: 'log', file: path.join(root, 'other.test.ts'), scope: 'file', names: [], type: 'stdout', content: 'elsewhere\n' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
    return {
      passed: true, stdout: '', stderr: '',
      jsonOutput: JSON.stringify({ testResults: [{ name: testFile, status: 'passed', assertionResults: [
        { ancestorTitles: ['s'], title: 't', fullName: 's t', status: 'passed', failureMessages: [] },
      ] }] }),
    };
  });
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  const res = await runner.runTestFileJson(testFile);
  expect(res.fileResults[0].consoleOutput).toEqual([
    { message: 'module', type: 'log', origin: '', scope: 'file' },
    { message: 'in test', type: 'log', origin: 's > t', scope: 'test', scopeName: 's t' },
  ]);
  expect(fs.existsSync(eventsFile)).toBe(false);
});
