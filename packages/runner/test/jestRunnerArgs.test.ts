import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JestRunner } from '../src/JestRunner';
import { Executor, ExecutorCommand } from '../src/execution/Executor';
import { CRAAdapter } from '../src/framework/adapters/CRAAdapter';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';

/**
 * The exact commands JestRunner hands to the Executor. These snapshots pin
 * the Jest command lines: refactoring the runner layer must not change them.
 */

let root: string;
let calls: ExecutorCommand[];

/** A command with the machine-specific parts replaced, so snapshots are stable. */
function stable(cmd: ExecutorCommand) {
  const fix = (s: string) => s.split(root).join('<root>').replace(/^--maxWorkers=\d+$/, '--maxWorkers=<n>');
  return { binary: fix(cmd.binary), args: cmd.args.map(fix), cwd: fix(cmd.cwd), timeoutMs: cmd.timeoutMs };
}

function project(pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const jestDir = path.join(root, 'node_modules', 'jest');
  fs.mkdirSync(path.join(jestDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(jestDir, 'package.json'), JSON.stringify({ name: 'jest', bin: './bin/jest.js' }));
  fs.writeFileSync(path.join(jestDir, 'bin', 'jest.js'), '');
}

beforeEach(() => {
  _resetProjectRoots();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-args-')));
  calls = [];
  jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: '', stderr: '', jsonOutput: '{"testResults":[]}' };
  });
  jest.spyOn(Executor.prototype, 'run').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: path.join(root, 'src', 'a.test.js') + '\n', stderr: '' };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('JestRunner command lines (plain Jest)', () => {
  beforeEach(() => project({ devDependencies: { jest: '*' }, scripts: { test: 'jest --resetMocks' } }));

  it('builds every run kind exactly as before', async () => {
    const runner = new JestRunner();
    runner.setFileTimeout(5000);
    await runner.discoverTests(root);
    await runner.runFullSuiteJson(root, false);
    await runner.runFullSuiteJson(root, true);
    await runner.runTestFileJson(path.join(root, 'src', 'a.test.js'));
    await runner.runTestFilesJson([path.join(root, 'src', 'a.test.js'), path.join(root, 'src', 'b.test.js')]);
    await runner.runTestCaseJson(path.join(root, 'src', 'a.test.js'), 'Suite a|Suite b');
    await runner.runTestCaseJson(path.join(root, 'src', 'a.test.js'), 'Suite', true);
    await runner.runRelatedTestsJson(path.join(root, 'src', 'util.js'));
    expect(calls.map(stable)).toMatchSnapshot();
  });

  it('puts the user command first and its extra words before the Jest args', async () => {
    const runner = new JestRunner('npm test --');
    runner.setProjectRoot(root);
    await runner.runTestFileJson(path.join(root, 'src', 'a.test.js'));
    expect(calls.map(stable)).toMatchSnapshot();
  });

  it('splits long file lists into several runs', async () => {
    const runner = new JestRunner();
    runner.setProjectRoot(root);
    const files = Array.from({ length: 80 }, (_, i) => path.join(root, 'src', `${'x'.repeat(60)}-${i}.test.js`));
    await runner.runTestFilesJson(files);
    // How many runs depends on the temp path's length; the shape does not.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap((c) => c.args.filter((a) => a.endsWith('.test.js'))).length).toBe(80);
    const withoutFiles = calls.map((c) => stable({ ...c, args: c.args.filter((a) => !a.endsWith('.test.js')) }));
    expect(new Set(withoutFiles.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(withoutFiles[0]).toMatchSnapshot();
  });
});

describe('JestRunner command lines (Create React App)', () => {
  beforeEach(() => {
    project({ dependencies: { 'react-scripts': '5.0.1' }, scripts: { test: 'react-scripts test --resetMocks --config x.js' } });
    jest.spyOn(CRAAdapter.prototype, 'resolveConfig').mockResolvedValue(path.join(root, 'cra-config.json'));
  });

  it('passes the extracted config and the test-script flags (without --config)', async () => {
    const runner = new JestRunner();
    runner.setProjectRoot(root);
    await runner.runTestFileJson(path.join(root, 'src', 'App.test.js'));
    expect(calls.map(stable)).toMatchSnapshot();
  });
});
