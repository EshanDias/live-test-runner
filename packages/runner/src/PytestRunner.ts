import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRunner, RunRequest, TestFileList } from './CommandRunner';
import { ExecutionResult, ExecutorCommand, tail } from './execution/Executor';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { FrameworkRegistry } from './framework/FrameworkRegistry';
import { LTR_PYTEST_SOURCE } from './framework/pytest/ltrPytestSource';
import { nodeIdsFor, pytestPluginDir } from './framework/pytest/pytestNodeIds';
import { pythonFor } from './framework/pytest/python';
import { fromRunnerPath } from './resolution/RunnerPaths';
import { RunResult } from './types';
import { createLogger } from './utils/logger';

const log = createLogger('PytestRunner');

/** Where the plugin appends its live events (JSON lines). */
export const PYTEST_EVENTS_ENV = 'LTR_PYTEST_EVENTS';
/** Where the plugin writes the collected test files of a `--collect-only` run. */
export const PYTEST_LIST_ENV = 'LTR_PYTEST_LIST';
/** Folder for coverage data; set → the plugin measures coverage with coverage.py. */
export const PYTEST_COVERAGE_ENV = 'LTR_PYTEST_COVERAGE';

/** What a pytest `--collect-only` run reported (plugin LIST file). */
export interface PytestListing {
  files: string[];
  errors: { file: string; message: string }[];
  rootdir?: string;
  inifile?: string | null;
  python_files?: string[];
  testpaths?: string[];
}

/** A pytest exit status explained for the log (0, 1 and 5 are normal). */
export function pytestExitReason(code: number | undefined): string | undefined {
  switch (code) {
    case 2: return 'pytest was interrupted (exit 2) — usually an error while collecting, or Ctrl+C';
    case 3: return 'pytest hit an internal error (exit 3) — a plugin or conftest.py crashed';
    case 4: return 'pytest rejected the command line (exit 4) — often an option in the project\'s addopts that needs a plugin not installed in this Python environment';
    default: return undefined;
  }
}

/**
 * A test file as a pytest argument: relative to the project root (the cwd)
 * when inside it — node ids then read like the user's own (`tests/test_x.py::…`)
 * whatever spelling the editor has (Python's cwd is the real path: macOS
 * /private/var, resolved symlinks) — else absolute.
 */
export function toPytestPathArg(projectRoot: string, file: string): string {
  const rel = path.relative(projectRoot, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/**
 * PytestRunner — the TestRunner for pytest projects.
 *
 *   <python> -m pytest -p ltr_pytest [targets] --color=no --continue-on-collection-errors
 *            -o cache_dir=<session> [-n 0] [--no-cov] [pytestArgs] --ltr-result=<tmp>
 *
 * The project's own interpreter (registered by the extension, see python.ts)
 * runs pytest from the project root, with the shipped plugin on PYTHONPATH
 * (`-p` names it only on this command line — never an env var, so pytest's
 * own inner sessions and the user's terminal runs never load it). Targets:
 * nothing (pytest's own testpaths), test files, or node ids.
 *
 * Our runs leave the project as it was: pytest's cache goes to the session
 * folder (`--lf` state untouched), pytest-cov is idle (`--no-cov`; our plugin
 * measures with coverage.py into the session folder), and xdist gets `-n 0`
 * — our batches are the parallelism, within the machine's budget (D14, D19).
 */
export class PytestRunner extends CommandRunner {
  protected readonly runnerName = 'PytestRunner';

  constructor(
    command = '',
    logger: (msg: string) => void = () => {},
    tmpDir?: string,
    private readonly extraArgs: string[] = [],
  ) {
    super(command, logger, tmpDir);
  }

  protected override get processLabel(): string { return 'pytest'; }

  /** pytest's own progress goes to stdout — the Test Output channel. */
  protected override get forwardsStdout(): boolean { return true; }

  /** No NODE_ENV / CI: a run must behave like the user's own `pytest`. */
  protected override get jsEnv(): boolean { return false; }

  protected detectAdapter(_projectRoot: string): FrameworkAdapter {
    const adapter = FrameworkRegistry.default().get('pytest');
    if (!adapter) { throw new Error('PytestRunner: the pytest adapter is not registered'); }
    return adapter;
  }

  protected override leadingArgs(_request: RunRequest): string[] {
    return ['-m', 'pytest', '-p', 'ltr_pytest'];
  }

  protected buildArgs(request: RunRequest): string[] {
    return [...this.targets(request), ...this.baseArgs(), ...(request.kind === 'list' ? ['--collect-only', '-q'] : [])];
  }

  /** Flags every run gets (see the class comment). */
  private baseArgs(): string[] {
    const info = pythonFor(this.requireProjectRoot());
    return [
      '--color=no',
      '--continue-on-collection-errors',
      '-o', `cache_dir=${path.join(this.sessionDir(), 'pytest-cache')}`,
      ...(info?.xdist ? ['-n', '0'] : []),
      ...(info?.pytestCov ? ['--no-cov'] : []),
      ...this.extraArgs,
    ];
  }

  private targets(request: RunRequest): string[] {
    switch (request.kind) {
      case 'list':
      case 'full':
        return [];
      case 'files':
        return request.files.map((f) => toPytestPathArg(this.requireProjectRoot(), f));
      case 'testCase': {
        const names = request.names ?? [request.testFullName];
        const file = toPytestPathArg(this.requireProjectRoot(), request.file);
        const ids = nodeIdsFor(file, names, request.isTestSuite);
        if (!ids) {
          log.warn(`Could not turn ${names.map((n) => `"${n}"`).join(', ')} into pytest node ids — running the whole of ${path.basename(request.file)}`);
          return [file];
        }
        return ids;
      }
      case 'related':
        // Tests related to a source file come from coverage contexts (the extension), not from pytest.
        throw new Error('pytest has no related-tests run');
    }
  }

  protected override runEnv(request: RunRequest): Record<string, string> | undefined {
    const env = this.pythonEnv();
    if (request.kind === 'full' && request.withCoverage) {
      env[PYTEST_COVERAGE_ENV] = path.dirname(this.coverageFile(this.requireProjectRoot()));
    }
    return env;
  }

  /** PYTHONPATH with the plugin first, unbuffered UTF-8 output (Windows consoles default to a code page). */
  private pythonEnv(): Record<string, string> {
    const pluginDir = pytestPluginDir(this.sessionDir(), LTR_PYTEST_SOURCE);
    const existing = process.env.PYTHONPATH;
    return {
      PYTHONPATH: existing ? `${pluginDir}${path.delimiter}${existing}` : pluginDir,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    };
  }

  private sessionDir(): string {
    return this.tmpDir ?? os.tmpdir();
  }

  /** Test files from pytest's own collection (`--collect-only`, written by the plugin). */
  override async listTestFiles(projectRoot: string): Promise<TestFileList> {
    this.setProjectRoot(projectRoot);
    const listFile = path.join(this.sessionDir(), `ltr-pytest-list-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const result = await this.executor.run({
      binary: this.resolveBinary(),
      args: await this.commandArgs({ kind: 'list' }),
      cwd: projectRoot,
      label: this.processLabel,
      jsEnv: false,
      extraEnv: { ...this.pythonEnv(), [PYTEST_LIST_ENV]: listFile },
    });
    let listing: PytestListing | undefined;
    try {
      listing = JSON.parse(fs.readFileSync(listFile, 'utf8')) as PytestListing;
    } catch {
      listing = undefined;
    } finally {
      try { fs.unlinkSync(listFile); } catch { /* not written */ }
    }
    if (!listing) {
      throw new Error(`pytest --collect-only gave no list of test files. pytest said:\n${tail(result.stderr || result.stdout, 15)}`);
    }
    if (listing.errors.length > 0) {
      log.warn(`pytest could not collect ${listing.errors.length} file(s) — they are shown as failed: ${listing.errors.map((e) => path.basename(e.file)).join(', ')}`);
    }
    log.debug(`pytest --collect-only: ${listing.files.length} test file(s) (rootdir ${listing.rootdir}, config ${listing.inifile ?? 'none'})`);
    return { files: listing.files.map((f) => fromRunnerPath(f)) };
  }

  protected parseTestList(_result: ExecutionResult, _projectRoot: string): string[] {
    return []; // listTestFiles reads the plugin's file instead
  }

  protected coverageFile(_projectRoot: string): string {
    return path.join(this.sessionDir(), 'pytest-coverage', 'coverage-final.json');
  }

  /**
   * Runs named tests / suites of one file by node id (see pytestNodeIds).
   * `names` as the store holds them.
   */
  runTestsByName(filePath: string, names: string[], isTestSuite: boolean): Promise<RunResult> {
    return this.runJson({ kind: 'testCase', file: filePath, testFullName: names.join(' | '), names, isTestSuite }, this.fileTimeout);
  }

  /**
   * The command of a session batch whose results are read live from the
   * plugin's events (PytestBatchRunner in the extension).
   */
  async liveCommand(
    files: string[],
    options: { coverageDir?: string } = {},
  ): Promise<{ command: ExecutorCommand; eventsFile: string; resultFile: string; coverageFile?: string }> {
    const root = this.requireProjectRoot();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const eventsFile = path.join(this.sessionDir(), `ltr-pytest-events-${stamp}.jsonl`);
    const resultFile = path.join(this.sessionDir(), `ltr-result-${stamp}.json`);
    const args = [...await this.commandArgs({ kind: 'files', files }), ...this.requireAdapter().outputFileArg(resultFile)];
    const extraEnv: Record<string, string> = { ...this.pythonEnv(), [PYTEST_EVENTS_ENV]: eventsFile };
    if (options.coverageDir) { extraEnv[PYTEST_COVERAGE_ENV] = options.coverageDir; }
    return {
      command: { binary: this.resolveBinary(), args, cwd: root, extraEnv, label: this.processLabel, forwardStdout: true, jsEnv: false },
      eventsFile,
      resultFile,
      coverageFile: options.coverageDir ? path.join(options.coverageDir, 'coverage-final.json') : undefined,
    };
  }

  /** `-m pytest` arguments for a debug launch of these tests (no plugin: a plain pytest run). */
  debugArgs(filePath: string, names: string[] | undefined, isTestSuite: boolean): string[] {
    const info = pythonFor(this.requireProjectRoot());
    const file = toPytestPathArg(this.requireProjectRoot(), filePath);
    const targets = names && names.length > 0 ? nodeIdsFor(file, names, isTestSuite) ?? [file] : [file];
    return [
      ...targets,
      '--color=no',
      '-p', 'no:cacheprovider',
      ...(info?.xdist ? ['-n', '0'] : []),
      ...(info?.pytestCov ? ['--no-cov'] : []),
      ...this.extraArgs,
    ];
  }
}
