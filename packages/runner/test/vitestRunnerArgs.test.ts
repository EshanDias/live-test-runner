import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestRunner, toVitestNamePattern } from '../src/VitestRunner';
import { Executor, ExecutorCommand } from '../src/execution/Executor';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';

/** The exact commands VitestRunner hands to the Executor. */

let root: string;
let calls: ExecutorCommand[];
let outputFileArgs: ((file: string) => string[])[];
let listStdout: string;

function stable(cmd: ExecutorCommand) {
  const fix = (s: string) => s.split(root).join('<root>').split(fs.realpathSync(os.tmpdir())).join('<tmp>').split(os.tmpdir()).join('<tmp>');
  return { binary: fix(cmd.binary), args: cmd.args.map(fix), cwd: fix(cmd.cwd), timeoutMs: cmd.timeoutMs, label: cmd.label };
}

function project(pkg: Record<string, unknown>, version = '5.0.5', files: Record<string, string> = {}): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const dir = path.join(root, 'node_modules', 'vitest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vitest', version, bin: { vitest: './vitest.mjs' } }));
  fs.writeFileSync(path.join(dir, 'vitest.mjs'), '');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

beforeAll(() => setLogSink(() => {}));
afterAll(() => setLogSink(undefined));

beforeEach(() => {
  _resetProjectRoots();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vargs-')));
  calls = [];
  outputFileArgs = [];
  listStdout = '';
  jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd, outputFileArg) => {
    calls.push(cmd);
    outputFileArgs.push(outputFileArg);
    return { passed: true, stdout: '', stderr: '', jsonOutput: '{"testResults":[]}' };
  });
  jest.spyOn(Executor.prototype, 'run').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: listStdout, stderr: '' };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VitestRunner command lines', () => {
  it('builds every run kind (Vitest 5, config file)', async () => {
    project({ devDependencies: { vitest: '5' }, scripts: { test: 'vitest run' } }, '5.0.5', { 'vitest.config.ts': '' });
    listStdout = JSON.stringify([{ file: path.join(root, 'src', 'a.test.ts') }]);
    const runner = new VitestRunner();
    runner.setFileTimeout(5000);
    await runner.discoverTests(root);
    await runner.runFullSuiteJson(root, false);
    await runner.runFullSuiteJson(root, true);
    await runner.runTestFileJson(path.join(root, 'src', 'a.test.ts'));
    await runner.runTestFilesJson([path.join(root, 'src', 'a.test.ts'), path.join(root, 'src', 'b.test.ts')]);
    await runner.runTestCaseJson(path.join(root, 'src', 'a.test.ts'), 'Suite a|Suite b');
    await runner.runTestCaseJson(path.join(root, 'src', 'a.test.ts'), 'Suite', true);
    await runner.runRelatedTestsJson(path.join(root, 'src', 'util.ts'));
    expect(calls.map(stable)).toMatchSnapshot();
    expect(outputFileArgs.map((f) => f('/tmp/out.json'))).toEqual(Array(7).fill(['--outputFile.json=/tmp/out.json']));
  });

  it('runs an old Vitest best-effort: no task-location flag, related → full run', async () => {
    project({ devDependencies: { vitest: '2' } }, '2.1.9');
    const runner = new VitestRunner();
    runner.setProjectRoot(root);
    await runner.runTestFileJson(path.join(root, 'src', 'a.test.ts'));
    await runner.runRelatedTestsJson(path.join(root, 'src', 'util.ts'));
    expect(calls.map(stable)).toMatchSnapshot();
  });

  it("passes the test script's config and project flags (vueuse shape)", async () => {
    project({
      devDependencies: { vitest: '4' },
      scripts: { test: 'nr test:unit --project=server', 'test:unit': 'vitest --project unit -c vitest.unit.ts' },
    }, '4.1.11', { 'vitest.unit.ts': '', 'vitest.config.ts': '' });
    const runner = new VitestRunner();
    runner.setProjectRoot(root);
    await runner.runFullSuiteJson(root);
    expect(calls.map(stable)).toMatchSnapshot();
  });

  it('puts the user command first, then the subcommand', async () => {
    project({ devDependencies: { vitest: '5' } });
    const runner = new VitestRunner('npx vitest');
    runner.setProjectRoot(root);
    await runner.runTestFileJson(path.join(root, 'src', 'a.test.ts'));
    expect(stable(calls[0]).binary).toBe('npx');
    expect(stable(calls[0]).args.slice(0, 3)).toEqual(['vitest', 'run', '<root>/src/a.test.ts']);
  });
});

describe('vitest list output', () => {
  it('reads the JSON file list, once per file, after any noise', async () => {
    project({ devDependencies: { vitest: '5' } });
    const a = path.join(root, 'a.test.ts');
    listStdout = `some config log\n${JSON.stringify([{ file: a, projectName: 'unit' }, { file: a, projectName: 'server' }, { file: path.join(root, 'b.test.ts') }])}`;
    expect(await new VitestRunner().discoverTests(root)).toEqual([a, path.join(root, 'b.test.ts')]);
  });

  it('falls back to a folder scan when there is no list', async () => {
    project({ devDependencies: { vitest: '5' } }, '5.0.5', { 'src/x.spec.ts': '' });
    listStdout = 'Collect Error';
    expect(await new VitestRunner().discoverTests(root)).toEqual([path.join(root, 'src', 'x.spec.ts')]);
  });

  it('runs from the real path when the root is opened through another spelling (Windows 8.3 names, symlinks)', async () => {
    project({ devDependencies: { vitest: '5' } }, '5.0.5', { 'vitest.config.ts': '' });
    // A junction works without admin rights on Windows; a symlink elsewhere.
    const link = path.join(os.tmpdir(), `ltr-vargs-link-${process.pid}`);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(root, link, 'junction');
    try {
      const runner = new VitestRunner();
      runner.setProjectRoot(link);
      await runner.runTestFileJson(path.join(link, 'src', 'a.test.ts'));
      const [cmd] = calls;
      // cwd (Vitest's root), config and file filter all spelled the same way.
      expect(cmd.cwd).toBe(root);
      expect(cmd.args).toContain(path.join(root, 'vitest.config.ts'));
      expect(cmd.args).toContain(path.join(root, 'src', 'a.test.ts').replace(/\\/g, '/'));
      expect(cmd.args.join(' ')).not.toContain(link);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });
});

describe('toVitestNamePattern', () => {
  it('matches Vitest 5 (" > ") and older (" ") full names', () => {
    const test = new RegExp(toVitestNamePattern('Outer Inner adds', false));
    expect(test.test('Outer > Inner > adds')).toBe(true);
    expect(test.test('Outer Inner adds')).toBe(true);
    expect(test.test('Outer > Inner > adds more')).toBe(false);
  });

  it('matches the tests of a suite, not a longer suite name', () => {
    const suite = new RegExp(toVitestNamePattern('Outer Inner', true));
    expect(suite.test('Outer > Inner > adds')).toBe(true);
    expect(suite.test('Outer Inner adds')).toBe(true);
    expect(suite.test('Outer > Innermost > adds')).toBe(false);
  });

  it('keeps alternatives and escaped characters', () => {
    const p = new RegExp(toVitestNamePattern('a b\\(1\\)|c d', false));
    expect(p.test('a > b(1)')).toBe(true);
    expect(p.test('c > d')).toBe(true);
    expect(p.test('a > b1')).toBe(false);
  });
});
