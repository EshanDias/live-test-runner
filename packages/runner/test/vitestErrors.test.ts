import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorLocation, formatVitestError, VITEST_EVENTS_ENV } from '../src/framework/vitestReporter';
import { VitestRunner } from '../src/VitestRunner';
import { Executor } from '../src/execution/Executor';
import { VITEST_HOOK_FAILURE } from '../src/parsing/VitestResultParser';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';

describe('Vitest error locations', () => {
  it('takes the first project frame from parsed stacks (Vitest 4+)', () => {
    expect(errorLocation({ message: 'x', stacks: [
      { file: '/p/node_modules/@vitest/expect/dist/index.js', line: 1, column: 1 },
      { file: '/p/src/a.test.ts', line: 5, column: 30 },
    ] })).toEqual({ file: '/p/src/a.test.ts', line: 5, column: 30 });
  });

  it('parses V8 stack text (Vitest 1 – 3), skipping runner frames', () => {
    const stack = [
      'AssertionError: expected 1 to be 2',
      '    at Proxy.<anonymous> (file:///p/node_modules/@vitest/expect/dist/index.js:1:1)',
      '    at /p/src/a.test.ts:9:40',
      '    at file:///p/node_modules/@vitest/runner/dist/index.js:2:2',
    ].join('\n');
    expect(errorLocation({ message: 'x', stack })).toEqual({ file: '/p/src/a.test.ts', line: 9, column: 40 });
    expect(errorLocation({ message: 'x', stack: 'Error: x\n    at fn (C:\\p\\src\\b.test.ts:3:7)' })).toEqual({ file: 'C:\\p\\src\\b.test.ts', line: 3, column: 7 });
    expect(errorLocation({ message: 'x', stack: 'Error: x\n    at node:internal/process/task_queues:1:1' })).toBeUndefined();
  });

  it('formats name, message, plain diff and a project-relative location', () => {
    expect(formatVitestError({
      name: 'AssertionError', message: 'expected 1 to be 2',
      diff: '\u001b[32m- Expected\u001b[39m\n\u001b[31m+ Received\u001b[39m\n\n\u001b[32m- 2\u001b[39m\n\u001b[31m+ 1\u001b[39m',
      stacks: [{ file: '/p/src/a.test.ts', line: 5, column: 30 }],
    }, '/p')).toBe('AssertionError: expected 1 to be 2\n\n- Expected\n+ Received\n\n- 2\n+ 1\n\n❯ src/a.test.ts:5:30');
    expect(formatVitestError({ name: 'Error', message: 'setup broke' }, '/p')).toBe('setup broke');
  });
});

describe('VitestRunner — failures from the reporter', () => {
  let root: string;
  beforeAll(() => setLogSink(() => {}));
  afterAll(() => setLogSink(undefined));
  beforeEach(() => {
    _resetProjectRoots();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-verr-')));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '5' } }));
    const dir = path.join(root, 'node_modules', 'vitest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vitest', version: '5.0.5', bin: { vitest: './vitest.mjs' } }));
    fs.writeFileSync(path.join(dir, 'vitest.mjs'), '');
  });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('replaces test messages with diff + location, and names a failing hook', async () => {
    const a = path.join(root, 'a.test.ts');
    const b = path.join(root, 'hook.test.ts');
    jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd) => {
      fs.writeFileSync(cmd.extraEnv![VITEST_EVENTS_ENV], [
        { ev: 'error', file: a, scope: 'test', names: ['s', 'fails'], errors: [{ name: 'AssertionError', message: 'expected 1 to be 2', diff: '- 2\n+ 1', stacks: [{ file: a, line: 4, column: 9 }] }] },
        { ev: 'error', file: b, scope: 'suite', names: ['Hooked'], errors: [{ name: 'Error', message: 'setup broke', stacks: [{ file: b, line: 3, column: 27 }] }] },
      ].map((e) => JSON.stringify(e)).join('\n'));
      return {
        passed: false, stdout: '', stderr: '',
        jsonOutput: JSON.stringify({ testResults: [
          { name: a, status: 'failed', assertionResults: [{ ancestorTitles: ['s'], title: 'fails', fullName: 's fails', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at ...'] }] },
          { name: b, status: 'failed', message: '', assertionResults: [{ ancestorTitles: ['Hooked'], title: 't', fullName: 'Hooked t', status: 'skipped', failureMessages: [] }] },
        ] }),
      };
    });
    const runner = new VitestRunner();
    runner.setProjectRoot(root);
    const res = await runner.runTestFilesJson([a, b]);
    expect(res.fileResults[0].testCases[0].failureMessages).toEqual(['AssertionError: expected 1 to be 2\n\n- 2\n+ 1\n\n❯ a.test.ts:4:9']);
    expect(res.fileResults[1].failureMessage).not.toBe(VITEST_HOOK_FAILURE);
    expect(res.fileResults[1].failureMessage).toBe('In "Hooked" (a beforeAll / afterAll hook or the suite itself):\nsetup broke\n\n❯ hook.test.ts:3:27');
  });
});
