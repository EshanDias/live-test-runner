import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from './TestRunner';
import { RunResult } from './types';
import { FrameworkDetector } from './framework/FrameworkDetector';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { Executor } from './execution/Executor';
import { ResultParser } from './parsing/ResultParser';

/**
 * JestRunner — the public-facing test runner for Jest-based projects.
 *
 * Responsibilities (thin orchestration only):
 *  1. Detect the framework once per project root (CRA, plain Jest, etc.)
 *  2. Delegate binary + config resolution to the correct FrameworkAdapter
 *  3. Build the command and hand it to Executor
 *  4. Pass raw output to ResultParser
 *
 * All framework-specific logic lives in the adapters.
 * All process management lives in Executor.
 * All JSON parsing lives in ResultParser.
 */
export class JestRunner implements TestRunner {
  private readonly detector = new FrameworkDetector();
  private readonly parser = new ResultParser();
  private readonly executor: Executor;

  private adapter?: FrameworkAdapter;
  private projectRoot?: string;
  private userJestCommand: string;

  constructor(
    jestCommand: string = '',
    logger: (msg: string) => void = () => {},
    tmpDir?: string,
  ) {
    this.userJestCommand = jestCommand;
    this.executor = new Executor(logger, tmpDir);
  }

  // ── TestRunner interface ────────────────────────────────────────────────────

  setLogger(logger: (msg: string) => void): void {
    this.executor.setLogger(logger);
  }

  setProjectRoot(root: string): void {
    this.initAdapter(root);
  }

  async discoverTests(projectRoot: string): Promise<string[]> {
    this.initAdapter(projectRoot);
    const adapter = this.requireAdapter();
    const cwd = this.requireProjectRoot();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);
    const args = [
      ...prefixArgs,
      ...configArgs,
      ...this.baseArgs(),
      '--listTests',
      '--passWithNoTests',
    ];

    const result = await this.executor.run({ binary, args, cwd });

    // A config validation error means Jest rejected the config file entirely.
    // The output contains error prose, not file paths — abort immediately so we
    // don't parse Jest's error text as test file paths (Bug 3).
    if (!result.passed && this.isJestValidationError(result.stderr)) {
      throw new Error(
        `[JestRunner] Jest config validation failed:\n${result.stderr.trim()}`,
      );
    }

    const found = this.parser.parseListTestsOutput(
      result.stdout + '\n' + result.stderr,
    );
    if (found.length > 0) return found;

    // Last resort: filesystem scan
    return this.discoverFromFilesystem(projectRoot);
  }

  async runFullSuiteJson(
    projectRoot: string,
    withCoverage = false,
    updateSnapshot = false,
  ): Promise<RunResult> {
    this.initAdapter(projectRoot);
    const adapter = this.requireAdapter();
    const cwd = this.requireProjectRoot();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);
    const coverageArgs = withCoverage
      ? [
          '--coverage',
          '--coverageReporters=json',
          '--coverageReporters=json-summary',
        ]
      : [];

    const args = [
      ...prefixArgs,
      ...configArgs,
      ...adapter.getExtraArgs(projectRoot),
      ...this.baseArgs(),
      ...(updateSnapshot ? ['--updateSnapshot'] : []),
      '--json',
      ...coverageArgs,
    ];

    const { passed, jsonOutput, stderr } =
      await this.executor.runWithJsonCapture({ binary, args, cwd });
    return this.parser.parse(passed, jsonOutput, stderr);
  }

  async runTestFileJson(filePath: string, updateSnapshot = false): Promise<RunResult> {
    const projectRoot = this.requireProjectRoot();
    const adapter = this.requireAdapter();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);
    const args = [
      ...prefixArgs,
      ...configArgs,
      ...adapter.getExtraArgs(projectRoot),
      ...this.baseArgs(),
      ...(updateSnapshot ? ['--updateSnapshot'] : []),
      '--json',
      '--runTestsByPath',
      this.normalisePath(filePath),
    ];

    const { passed, jsonOutput, stderr } =
      await this.executor.runWithJsonCapture({
        binary,
        args,
        cwd: projectRoot,
      });
    return this.parser.parse(passed, jsonOutput, stderr);
  }

  async runTestFilesJson(filePaths: string[], updateSnapshot = false): Promise<RunResult> {
    if (filePaths.length === 0) return this.parser.empty(true, []);
    if (filePaths.length === 1) return this.runTestFileJson(filePaths[0], updateSnapshot);

    const projectRoot = this.requireProjectRoot();
    const adapter = this.requireAdapter();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);

    const chunks = this.chunkByCommandLineLength(filePaths);

    if (chunks.length === 1) {
      const args = [
        ...prefixArgs,
        ...configArgs,
        ...adapter.getExtraArgs(projectRoot),
        ...this.baseArgs(),
        ...(updateSnapshot ? ['--updateSnapshot'] : []),
        '--json',
        '--runTestsByPath',
        ...filePaths.map((p) => this.normalisePath(p)),
      ];
      const { passed, jsonOutput, stderr } =
        await this.executor.runWithJsonCapture({
          binary,
          args,
          cwd: projectRoot,
        });
      return this.parser.parse(passed, jsonOutput, stderr);
    }

    // Multiple chunks — run sequentially and merge
    const results: RunResult[] = [];
    for (const chunk of chunks) {
      const args = [
        ...prefixArgs,
        ...configArgs,
        ...adapter.getExtraArgs(projectRoot),
        ...this.baseArgs(),
        ...(updateSnapshot ? ['--updateSnapshot'] : []),
        '--json',
        '--runTestsByPath',
        ...chunk.map((p) => this.normalisePath(p)),
      ];
      const { passed, jsonOutput, stderr } =
        await this.executor.runWithJsonCapture({
          binary,
          args,
          cwd: projectRoot,
        });
      results.push(this.parser.parse(passed, jsonOutput, stderr));
    }
    return this.parser.merge(results);
  }

  async runTestCaseJson(
    filePath: string,
    testFullName: string,
    isTestSuite: boolean = false,
    updateSnapshot: boolean = false,
  ): Promise<RunResult> {
    const projectRoot = this.requireProjectRoot();
    const adapter = this.requireAdapter();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);
    const args = [
      ...prefixArgs,
      ...configArgs,
      ...adapter.getExtraArgs(projectRoot),
      ...this.baseArgs(),
      ...(updateSnapshot ? ['--updateSnapshot'] : []),
      '--json',
      '--runTestsByPath',
      this.normalisePath(filePath),
      '--testNamePattern',
      isTestSuite ? `^${testFullName}` : `^${testFullName}$`,
    ];

    const { passed, jsonOutput, stderr } =
      await this.executor.runWithJsonCapture({
        binary,
        args,
        cwd: projectRoot,
      });
    return this.parser.parse(passed, jsonOutput, stderr);
  }

  async runRelatedTestsJson(filePath: string): Promise<RunResult> {
    const projectRoot = this.requireProjectRoot();
    const adapter = this.requireAdapter();

    const binary = this.resolveBinary(adapter, projectRoot);
    const prefixArgs = this.resolvePrefixArgs();
    const configArgs = await this.resolveConfigArgs(adapter, projectRoot);
    const args = [
      ...prefixArgs,
      ...configArgs,
      ...adapter.getExtraArgs(projectRoot),
      ...this.baseArgs(),
      '--json',
      '--findRelatedTests',
      this.normalisePath(filePath),
    ];

    const { passed, jsonOutput, stderr } =
      await this.executor.runWithJsonCapture({
        binary,
        args,
        cwd: projectRoot,
      });
    return this.parser.parse(passed, jsonOutput, stderr);
  }

  isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || filePath.includes('.spec.');
  }

  async getCoverage(): Promise<Record<string, unknown>> {
    const cwd = this.requireProjectRoot();
    const p = path.join(cwd, 'coverage', 'coverage-final.json');
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* fall through */
      }
    }
    return {};
  }

  killProcesses(): void {
    this.executor.kill();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private initAdapter(projectRoot: string): void {
    // Re-detect if root changes (e.g. user switches workspace folder)
    if (this.projectRoot !== projectRoot) {
      this.projectRoot = projectRoot;
      this.adapter = this.detector.detect(projectRoot);
    }
  }

  private requireAdapter(): FrameworkAdapter {
    if (!this.adapter)
      throw new Error(
        'JestRunner: no adapter — call setProjectRoot() or discoverTests() first.',
      );
    return this.adapter;
  }

  private requireProjectRoot(): string {
    if (!this.projectRoot)
      throw new Error(
        'JestRunner: projectRoot not set — call discoverTests(projectRoot) first.',
      );
    return this.projectRoot;
  }

  /**
   * If the user provided a custom jest command override, use that binary directly.
   * Otherwise delegate to the adapter's binary resolution.
   */
  private resolveBinary(
    adapter: FrameworkAdapter,
    projectRoot: string,
  ): string {
    if (this.userJestCommand.trim()) {
      return this.userJestCommand.trim().split(/\s+/)[0];
    }
    return adapter.resolveBinary(projectRoot);
  }

  /**
   * Any tokens after the first in userJestCommand become prefix args inserted
   * before Jest's own args. e.g. "npm test --" → binary="npm", prefix=["test","--"].
   */
  private resolvePrefixArgs(): string[] {
    const tokens = this.userJestCommand.trim().split(/\s+/);
    return tokens.length > 1 ? tokens.slice(1) : [];
  }

  /** Returns `['--config', '<path>']` if the adapter provides a config, or `[]`. */
  private async resolveConfigArgs(
    adapter: FrameworkAdapter,
    projectRoot: string,
  ): Promise<string[]> {
    const configPath = await adapter.resolveConfig(projectRoot);
    return configPath ? ['--config', configPath] : [];
  }

  /** Args that every Jest invocation needs regardless of framework or mode. */
  private baseArgs(): string[] {
    return [
      '--watchAll=false', // prevent Jest from entering watch mode
      '--forceExit', // prevent Jest from hanging after completion
      '--no-bail', // always run all tests, never stop on first failure
      '--testLocationInResults', // populate location.line in JSON output (needed for gutter decorations)
    ];
  }

  /**
   * Splits file paths into chunks so the command line doesn't exceed the
   * Windows 8191-character limit.
   */
  private chunkByCommandLineLength(
    filePaths: string[],
    maxCharsForPaths = 5500,
  ): string[][] {
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

  private isJestValidationError(stderr: string): boolean {
    return (
      stderr.includes('Validation Error') ||
      stderr.includes('Unknown option') ||
      stderr.includes('https://jestjs.io/docs/configuration')
    );
  }

  /**
   * Normalise a file path for use as a --runTestsByPath / --findRelatedTests argument.
   * On Windows two issues can cause "No files found":
   *  1. Backslash separators — Jest normalises its internal file list to forward
   *     slashes before regex-matching paths, so backslash paths don't match.
   *  2. Lowercase drive letter — VS Code can return `c:/...` but Jest (or the
   *     underlying fs) may have recorded the path with an uppercase drive letter
   *     `C:/...`, causing the match to fail on case-sensitive comparisons.
   * Both transforms are no-ops on macOS / Linux.
   */
  private normalisePath(filePath: string): string {
    return filePath
      .replace(/\\/g, '/')
      .replace(/^([a-z]):\//, (_, d: string) => `${d.toUpperCase()}:/`);
  }

  private discoverFromFilesystem(projectRoot: string): string[] {
    const testFiles: string[] = [];

    const scan = (dir: string) => {
      let items: string[] = [];
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
