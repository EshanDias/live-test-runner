import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestRunner, _setVitestConfigReader } from '../src/VitestRunner';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';

/** Vitest's own coverage in batches: only with the configured provider installed, into the given folder. */

let root: string;
const logs: string[] = [];
let provider = 'v8';

function project(version: string, providers: string[] = []): void {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: version } }));
  const dir = path.join(root, 'node_modules', 'vitest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vitest', version, bin: { vitest: './vitest.mjs' } }));
  fs.writeFileSync(path.join(dir, 'vitest.mjs'), '');
  for (const p of providers) {
    const pd = path.join(root, 'node_modules', '@vitest', `coverage-${p}`);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: `@vitest/coverage-${p}`, version }));
  }
}

beforeAll(() => {
  setLogSink((level, _scope, message) => logs.push(`${level} ${message}`));
  _setVitestConfigReader(async () => ({ projects: [{ name: '', browser: false }], coverageProvider: provider }));
});
afterAll(() => { setLogSink(undefined); _setVitestConfigReader(); });
beforeEach(() => {
  _resetProjectRoots();
  logs.length = 0;
  provider = 'v8';
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vcov-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function live(coverageDir?: string) {
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  return runner.liveCommand([path.join(root, 'a.test.ts')], { coverageDir });
}

it('adds json coverage into the folder when the provider is installed', async () => {
  project('5.0.5', ['v8']);
  const r = await live('/tmp/cov');
  expect(r.command.args.filter((a) => a.startsWith('--coverage'))).toEqual([
    '--coverage.enabled=true', '--coverage.reporter=json', '--coverage.reportsDirectory=/tmp/cov', '--coverage.reportOnFailure=true',
  ]);
  expect(r.coverageFile).toBe(path.join('/tmp/cov', 'coverage-final.json'));
});

it('limits Vitest < 4 to the files the tests loaded (coverage.all=false)', async () => {
  project('3.2.4', ['v8']);
  expect((await live('/tmp/cov')).command.args).toContain('--coverage.all=false');
});

it('uses the configured provider — and says once what to install when it is missing', async () => {
  provider = 'istanbul';
  project('5.0.5', ['v8']);
  const a = await live('/tmp/cov');
  await live('/tmp/cov');
  expect(a.command.args.some((x) => x.startsWith('--coverage'))).toBe(false);
  expect(a.coverageFile).toBeUndefined();
  expect(logs.filter((l) => /coverage is off .* @vitest\/coverage-istanbul/.test(l))).toHaveLength(1);
});

it('adds nothing without a coverage folder', async () => {
  project('5.0.5', ['v8']);
  const r = await live();
  expect(r.command.args.some((a) => a.startsWith('--coverage'))).toBe(false);
  expect(r.coverageFile).toBeUndefined();
});

it('builds a live related run: `related <src> --run`, with the batch flags and coverage', async () => {
  project('5.0.5', ['v8']);
  const runner = new VitestRunner();
  runner.setProjectRoot(root);
  const src = path.join(root, 'src', 'math.js');
  const r = await runner.liveCommand([path.join(root, 'ignored.test.ts')], { coverageDir: '/tmp/cov', related: src });
  expect(r.command.args.slice(0, 2)).toEqual(['related', src]);
  expect(r.command.args).toContain('--run');
  expect(r.command.args.some((a) => a.includes('ignored.test.ts'))).toBe(false);
  expect(r.command.args).toContain('--coverage.enabled=true');
  expect(r.eventsFile).toBeTruthy();
});
