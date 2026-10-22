import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestRunner, _setVitestProjectsReader } from '../src/VitestRunner';
import { Executor, ExecutorCommand } from '../src/execution/Executor';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';
import { VitestProjectInfo } from '../src/framework/vitestProjects';

const probe = jest.fn<Promise<VitestProjectInfo[] | undefined>, unknown[]>();

/** Browser-mode projects are left out with --project=<others>, unless asked for. */

let root: string;
let calls: ExecutorCommand[];
const logs: string[] = [];

function project(scripts: Record<string, string> = {}): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4' }, scripts }));
  const dir = path.join(root, 'node_modules', 'vitest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vitest', version: '4.1.11', bin: { vitest: './vitest.mjs' } }));
  fs.writeFileSync(path.join(dir, 'vitest.mjs'), '');
}

const vueuseProjects = [
  { name: 'server', browser: false },
  { name: 'unit', browser: false },
  { name: 'browser (chromium)', browser: true },
];

beforeAll(() => {
  setLogSink((level, _scope, message) => logs.push(`${level} ${message}`));
  _setVitestProjectsReader(probe);
});
afterAll(() => { setLogSink(undefined); _setVitestProjectsReader(); });
beforeEach(() => {
  _resetProjectRoots();
  logs.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-guard-')));
  calls = [];
  probe.mockReset();
  jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { passed: true, stdout: '', stderr: '', jsonOutput: '{"testResults":[]}' };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const projectFlags = () => calls[0].args.filter((a) => a.startsWith('--project'));

it('names every non-browser project and says which were left out (once)', async () => {
  project({ test: 'vitest run' });
  probe.mockResolvedValue(vueuseProjects);
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  await runner.runFullSuiteJson(root);
  await runner.runTestFileJson(path.join(root, 'a.test.ts'));
  expect(projectFlags()).toEqual(['--project=server', '--project=unit']);
  expect(calls[1].args.filter((a) => a.startsWith('--project'))).toEqual(['--project=server', '--project=unit']);
  expect(logs.filter((l) => /browser-mode projects left out: browser \(chromium\)/.test(l))).toHaveLength(1);
});

it('runs everything when the setting includes browser projects', async () => {
  project();
  const spy = probe.mockResolvedValue(vueuseProjects);
  const runner = new VitestRunner('', () => {}, undefined, true);
  runner.setProjectRoot(root);
  await runner.runFullSuiteJson(root);
  expect(projectFlags()).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});

it("leaves the test script's own --project choice alone (vueuse)", async () => {
  project({ test: 'nr test:unit --project=server', 'test:unit': 'vitest --project unit' });
  const spy = probe.mockResolvedValue(vueuseProjects);
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  await runner.runFullSuiteJson(root);
  expect(projectFlags()).toEqual(['--project=unit', '--project=server']);
  expect(spy).not.toHaveBeenCalled();
});

it('adds nothing without browser projects, or when the projects cannot be read', async () => {
  project();
  probe.mockResolvedValueOnce([{ name: '', browser: false }]).mockResolvedValueOnce(undefined);
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  await runner.runFullSuiteJson(root);
  await runner.runFullSuiteJson(root);
  expect(calls.map((c) => c.args.filter((a) => a.startsWith('--project')))).toEqual([[], []]);
});

it('runs browser projects when there is nothing else, with a warning', async () => {
  project();
  probe.mockResolvedValue([{ name: 'browser', browser: true }]);
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  await runner.runFullSuiteJson(root);
  expect(projectFlags()).toEqual([]);
  expect(logs.some((l) => l.startsWith('warn') && /Every Vitest project .* uses browser mode/.test(l))).toBe(true);
});
