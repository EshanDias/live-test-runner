/**
 * Adapter conformance suite — what every FrameworkAdapter must do, whatever
 * the framework. A new adapter (e.g. Vitest) gets one call to
 * `describeAdapterConformance(...)` in adapterConformance.test.ts; framework
 * details (exact flags, JSON dialect) are supplied by the case, the checks
 * are the same for all.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrameworkAdapter } from '../src/framework/adapters/FrameworkAdapter';
import { FrameworkRegistry } from '../src/framework/FrameworkRegistry';
import { Executor, ExecutorCommand } from '../src/execution/Executor';
import { CommandRunner } from '../src/CommandRunner';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';
import { setLogSink } from '../src/utils/logger';

export interface ProjectFixture {
  /** package.json contents. */
  pkg: Record<string, unknown>;
  /** Extra files, path → contents (relative to the project root). */
  files?: Record<string, string>;
}

export interface AdapterConformanceCase {
  /** Suite title, e.g. "jest". */
  name: string;
  createAdapter(): FrameworkAdapter;
  /** Projects the adapter must claim. */
  matching: ProjectFixture[];
  /** Projects it must not claim. */
  notMatching: ProjectFixture[];
  /** A project to run against (its runner resolves a binary here). */
  runnable: ProjectFixture;
  /** Called before the runner is used, e.g. to stub an expensive config extraction. */
  prepareRun?(projectRoot: string): void;
  /**
   * A canned raw result for `canned.file` (relative to the project root)
   * holding one passing and one failing test with these full names.
   */
  canned: { raw: (projectRoot: string) => string; file: string; passed: string; failed: string };
}

function makeProject(fixture: ProjectFixture): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr conformance ')));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(fixture.pkg));
  for (const [rel, text] of Object.entries(fixture.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

export function describeAdapterConformance(c: AdapterConformanceCase): void {
  describe(`${c.name} adapter — conformance`, () => {
    const dirs: string[] = [];
    const project = (f: ProjectFixture) => { const d = makeProject(f); dirs.push(d); return d; };
    beforeAll(() => setLogSink(() => {}));
    afterAll(() => {
      setLogSink(undefined);
      for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
    });
    afterEach(() => jest.restoreAllMocks());

    it('has a framework id and is registered in the default registry', () => {
      const adapter = c.createAdapter();
      expect(typeof adapter.framework).toBe('string');
      expect(adapter.framework.length).toBeGreaterThan(0);
      expect(FrameworkRegistry.default().get(adapter.framework)).toBeDefined();
    });

    it('claims its own projects', () => {
      for (const f of c.matching) { expect(c.createAdapter().detect(project(f))).toBe(true); }
    });

    it('does not claim other projects, or a folder without package.json', () => {
      for (const f of c.notMatching) { expect(c.createAdapter().detect(project(f))).toBe(false); }
      const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr conformance empty ')));
      dirs.push(empty);
      expect(c.createAdapter().detect(empty)).toBe(false);
    });

    it('names a result file that contains the given path', () => {
      const args = c.createAdapter().outputFileArg('/tmp/ltr result.json');
      expect(args.length).toBeGreaterThan(0);
      expect(args.join(' ')).toContain('/tmp/ltr result.json');
    });

    it('parses its canned result: one passed, one failed test', () => {
      const root = project(c.runnable);
      const r = c.createAdapter().parseResult(false, c.canned.raw(root), '');
      const file = r.fileResults.find((f) => f.testFilePath === path.join(root, c.canned.file));
      expect(file).toBeDefined();
      const status = (name: string) => file!.testCases.find((t) => t.fullName === name)?.status;
      expect(status(c.canned.passed)).toBe('passed');
      expect(status(c.canned.failed)).toBe('failed');
      expect(file!.status).toBe('failed');
    });

    it('turns unreadable output into a failed result instead of throwing', () => {
      const r = c.createAdapter().parseResult(false, 'not json', 'the runner crashed');
      expect(r.passed).toBe(false);
      expect(r.fileResults).toEqual([]);
      expect(r.errors.join('\n')).toContain('the runner crashed');
    });

    it("creates a runner that passes the file and the adapter's result-file flag", async () => {
      const root = project(c.runnable);
      c.prepareRun?.(root);
      const adapter = c.createAdapter();
      const calls: { cmd: ExecutorCommand; outputFileArg: (f: string) => string[] }[] = [];
      jest.spyOn(Executor.prototype, 'runWithJsonCapture').mockImplementation(async (cmd, outputFileArg) => {
        calls.push({ cmd, outputFileArg });
        return { passed: true, stdout: '', stderr: '', jsonOutput: c.canned.raw(root) };
      });
      const runner = adapter.createRunner();
      runner.setProjectRoot(root);
      const result = await runner.runTestFileJson(path.join(root, c.canned.file));
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd.cwd).toBe(root);
      expect(calls[0].cmd.args.some((a) => a.replace(/\\/g, '/').endsWith(c.canned.file))).toBe(true);
      expect(calls[0].outputFileArg('/tmp/x.json')).toEqual(adapter.outputFileArg('/tmp/x.json'));
      expect(result.fileResults.length).toBeGreaterThan(0);
    });

    it('creates a runner whose kill is safe when nothing runs', () => {
      const runner = c.createAdapter().createRunner();
      expect(runner).toBeInstanceOf(CommandRunner);
      expect(() => runner.killProcesses()).not.toThrow();
    });

    beforeEach(() => _resetProjectRoots());
  });
}
