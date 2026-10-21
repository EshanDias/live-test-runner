import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from './TestRunner';
import { RunResult } from './types';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { ExecutionResult, Executor } from './execution/Executor';
import { emptyRunResult, mergeRunResults } from './parsing/runResults';
import { createLogger } from './utils/logger';
import { registerProjectRoot } from './resolution/RunnerPaths';

const log = createLogger('CommandRunner');

/** What a run should cover; the framework turns it into its own CLI args. */
export type RunRequest =
  | { kind: 'list' }
  | { kind: 'full'; withCoverage: boolean }
  | { kind: 'files'; files: string[] }
  | { kind: 'testCase'; file: string; testFullName: string; isTestSuite: boolean }
  | { kind: 'related'; file: string };

/**
 * CommandRunner — runs a command-line test framework in a child process.
 *
 * The generic half of every runner (thin orchestration only):
 *  1. Pick the project's FrameworkAdapter once per project root
 *  2. Resolve the binary (or the user's command override) and the config
 *  3. Build each command as
 *       [user-command words] [leading args] [config args] [adapter extra args] [framework args]
 *     where the leading args ({@link leadingArgs}: a subcommand and positionals,
 *     e.g. `run <file>` for Vitest; none for Jest) and the framework args
 *     ({@link buildArgs}) are framework-specific
 *  4. Hand it to Executor; the adapter names the result file flag and parses the JSON
 *
 * Subclasses (JestRunner, a VitestRunner) supply the adapter choice, the
 * framework args, how the test list is read, and where coverage lands.
 *
 * Imports no adapters: adapters create their runners, so a runner picks its
 * adapter in {@link detectAdapter} (JestRunner via FrameworkDetector).
 */
export abstract class CommandRunner implements TestRunner {
  protected readonly executor: Executor;

  private adapter?: FrameworkAdapter;
  private projectRoot?: string;
  private readonly userCommand: string;
  /** Limit for single-file runs (runTestFileJson / runTestCaseJson); 0 = none. */
  private fileTimeoutMs = 0;

  /** Name used in errors, e.g. "JestRunner". */
  protected abstract readonly runnerName: string;

  /** Tag for the process's output lines: `[jest#12]`. */
  protected get processLabel(): string { return 'jest'; }

  constructor(
    command: string = '',
    logger: (msg: string) => void = () => {},
    tmpDir?: string,
  ) {
    this.userCommand = command;
    this.executor = new Executor(logger, tmpDir);
    this.logger = logger;
    this.tmpDir = tmpDir;
  }

  /** Raw-output sink and temp dir, for subclasses that start helper processes. */
  protected readonly logger: (msg: string) => void;
  protected readonly tmpDir: string | undefined;

  // ── Framework-specific ──────────────────────────────────────────────────────

  /** The adapter for a project root this runner handles (e.g. plain Jest or CRA). */
  protected abstract detectAdapter(projectRoot: string): FrameworkAdapter;

  /** The framework's own args for a run (everything after the adapter's extra args). */
  protected abstract buildArgs(request: RunRequest): string[];

  /** Extra environment for a run's process (e.g. where a reporter writes). */
  protected runEnv(_request: RunRequest): Record<string, string> | undefined {
    return undefined;
  }

  /** Adds what the framework reported outside its JSON result (e.g. console output). */
  protected afterRun(_request: RunRequest, result: RunResult): RunResult {
    return result;
  }

  /** Forward the runner's stdout to the raw-output sink (Vitest's reporter prints there). */
  protected get forwardsStdout(): boolean { return false; }

  /**
   * Async work before a command is built (e.g. Vitest reading its projects).
   * Called for every command; implementations cache.
   */
  protected async prepare(_projectRoot: string, _configPath: string | undefined): Promise<void> {
    // nothing by default
  }

  /**
   * How a path is spelled in the spawned command (its cwd and `--config`).
   * Jest resolves its root to the real path itself, so the editor's spelling
   * is fine. Vitest uses the cwd exactly as given, and file filters must be
   * spelled the same way — Vitest returns the real path (see RunnerPaths).
   */
  protected spawnPath(p: string): string {
    return p;
  }

  /**
   * Args that must come first, before the config and the adapter's extra args:
   * a subcommand and its positionals (Vitest: `run <files>`, `list`). Jest has none.
   */
  protected leadingArgs(_request: RunRequest): string[] {
    return [];
  }

  /**
   * Test files from the output of a `list` run (paths in the editor's
   * spelling). Throw when the output is an error rather than a list; return
   * [] to fall back to a filesystem scan.
   */
  protected abstract parseTestList(result: ExecutionResult, projectRoot: string): string[];

  /** Where the framework writes its JSON coverage after a coverage run. */
  protected abstract coverageFile(projectRoot: string): string;

  // ── TestRunner interface ────────────────────────────────────────────────────

  setLogger(logger: (msg: string) => void): void {
    this.executor.setLogger(logger);
  }

  setProjectRoot(root: string): void {
    this.initAdapter(root);
  }

  /** Stop single-file runs that take longer than `ms` (a hanging test). 0 disables. */
  setFileTimeout(ms: number): void {
    this.fileTimeoutMs = Math.max(0, ms);
  }

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.initAdapter(projectRoot);
    const result = await this.executor.run({
      binary: this.resolveBinary(),
      args: await this.commandArgs({ kind: 'list' }),
      cwd: this.spawnPath(this.requireProjectRoot()),
      label: this.processLabel,
    });
    const found = this.parseTestList(result, projectRoot);
    if (found.length > 0) {
      return found;
    }
    log.warn(`${this.runnerName}: the test list was empty — falling back to a filesystem scan`);
    return this.discoverFromFilesystem(projectRoot);
  }

  async runFullSuiteJson(projectRoot: string, withCoverage = false): Promise<RunResult> {
    this.initAdapter(projectRoot);
    return this.runJson({ kind: 'full', withCoverage });
  }

  async runTestFileJson(filePath: string): Promise<RunResult> {
    return this.runJson({ kind: 'files', files: [filePath] }, this.fileTimeoutMs);
  }

  async runTestFilesJson(filePaths: string[]): Promise<RunResult> {
    if (filePaths.length === 0) return emptyRunResult(true, []);
    if (filePaths.length === 1) return this.runTestFileJson(filePaths[0]);

    // Run sequentially and merge when the paths would overflow the command line.
    const chunks = this.chunkByCommandLineLength(filePaths);
    const results: RunResult[] = [];
    for (const chunk of chunks) {
      results.push(await this.runJson({ kind: 'files', files: chunk }));
    }
    return results.length === 1 ? results[0] : mergeRunResults(results);
  }

  async runTestCaseJson(filePath: string, testFullName: string, isTestSuite = false): Promise<RunResult> {
    return this.runJson({ kind: 'testCase', file: filePath, testFullName, isTestSuite }, this.fileTimeoutMs);
  }

  async runRelatedTestsJson(filePath: string): Promise<RunResult> {
    return this.runJson({ kind: 'related', file: filePath });
  }

  isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.');
  }

  async getCoverage(): Promise<Record<string, unknown>> {
    const p = this.coverageFile(this.requireProjectRoot());
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        log.warn(`Could not parse ${p}`, err);
      }
    }
    return {};
  }

  killProcesses(): void {
    this.executor.kill();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async runJson(request: RunRequest, timeoutMs?: number): Promise<RunResult> {
    const adapter = this.requireAdapter();
    const cwd = this.spawnPath(this.requireProjectRoot());
    const binary = this.resolveBinary();
    const args = await this.commandArgs(request);
    const { passed, jsonOutput, stderr } = await this.executor.runWithJsonCapture(
      { binary, args, cwd, timeoutMs, label: this.processLabel, extraEnv: this.runEnv(request), forwardStdout: this.forwardsStdout },
      (file) => adapter.outputFileArg(file),
    );
    return this.afterRun(request, adapter.parseResult(passed, jsonOutput, stderr));
  }

  /** [user-command words] [leading args] [config args] [adapter extra args] [framework args] */
  private async commandArgs(request: RunRequest): Promise<string[]> {
    const adapter = this.requireAdapter();
    const projectRoot = this.requireProjectRoot();
    const configPath = await adapter.resolveConfig(projectRoot);
    await this.prepare(projectRoot, configPath);
    return [
      ...this.resolvePrefixArgs(),
      ...this.leadingArgs(request),
      ...(configPath ? ['--config', this.spawnPath(configPath)] : []),
      ...adapter.getExtraArgs(projectRoot),
      ...this.buildArgs(request),
    ];
  }

  private initAdapter(projectRoot: string): void {
    registerProjectRoot(projectRoot);
    // Re-detect if root changes (e.g. user switches workspace folder)
    if (this.projectRoot !== projectRoot) {
      this.projectRoot = projectRoot;
      this.adapter = this.detectAdapter(projectRoot);
    }
  }

  protected requireAdapter(): FrameworkAdapter {
    if (!this.adapter) {
      const err = new Error(`${this.runnerName}: no adapter — call setProjectRoot() or discoverTests() first.`);
      log.error(err.message);
      throw err;
    }
    return this.adapter;
  }

  protected requireProjectRoot(): string {
    if (!this.projectRoot) {
      const err = new Error(`${this.runnerName}: projectRoot not set — call discoverTests(projectRoot) first.`);
      log.error(err.message);
      throw err;
    }
    return this.projectRoot;
  }

  /**
   * If the user provided a custom command override, use that binary directly.
   * Otherwise delegate to the adapter's binary resolution.
   */
  private resolveBinary(): string {
    if (this.userCommand.trim()) {
      return this.userCommand.trim().split(/\s+/)[0];
    }
    return this.requireAdapter().resolveBinary(this.requireProjectRoot());
  }

  /**
   * Any tokens after the first in the user command become prefix args inserted
   * before the framework's own args. e.g. "npm test --" → binary="npm", prefix=["test","--"].
   */
  private resolvePrefixArgs(): string[] {
    const tokens = this.userCommand.trim().split(/\s+/);
    return tokens.length > 1 ? tokens.slice(1) : [];
  }

  /**
   * Splits file paths into chunks so the command line doesn't exceed the
   * Windows 8191-character limit.
   */
  private chunkByCommandLineLength(filePaths: string[], maxCharsForPaths = 5500): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;

    for (const fp of filePaths) {
      const len = fp.length + 1;
      if (current.length > 0 && currentLen + len > maxCharsForPaths) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(fp);
      currentLen += len;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private discoverFromFilesystem(projectRoot: string): string[] {
    const testFiles: string[] = [];

    const scan = (dir: string) => {
      let items: string[];
      try {
        items = fs.readdirSync(path.join(projectRoot, dir));
      } catch {
        return;
      }

      for (const item of items) {
        const rel = path.join(dir, item);
        const abs = path.join(projectRoot, rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }

        if (st.isDirectory()) {
          if (
            item.startsWith('.') ||
            ['node_modules', 'build', 'dist', 'out', 'coverage'].includes(item)
          )
            continue;
          scan(rel);
        } else if (st.isFile()) {
          if (item.includes('.test.') || item.includes('.spec.'))
            testFiles.push(abs);
        }
      }
    };

    scan('');
    return testFiles;
  }
}
