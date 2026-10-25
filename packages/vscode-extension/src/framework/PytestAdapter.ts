import * as vscode from 'vscode';
import {
  CommandRunner,
  PytestAdapter as PytestRunnerAdapter,
  PytestRunner,
  pytestSettings,
  registerProjectRoot,
} from '@live-test-runner/runner';
import { RunnerBackedAdapter } from './RunnerBackedAdapter';
import { RerunOptions } from './IFrameworkAdapter';
import { ResultStore } from '../store/ResultStore';
import { matchesPythonFile } from '../session/discovery/pythonDiscovery';
import { pythonInterpreters } from '../python/PythonInterpreters';

/** `liveTestRunner.pytestArgs`: extra arguments for every pytest run. */
export function pytestArgsSetting(): string[] {
  const v = vscode.workspace.getConfiguration('liveTestRunner').get<unknown>('pytestArgs');
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string' && a.length > 0) : [];
}

/**
 * PytestAdapter — the pytest-specific part of the extension's framework
 * adapter: detection, the PytestRunner with the project's interpreter and
 * `liveTestRunner.pytestArgs`, node-id runs and the debugpy launch config.
 * Result mapping and the run operations are RunnerBackedAdapter's (shared
 * with Jest and Vitest) — the plugin reports in the same shapes.
 *
 * Every run first makes sure the project has a usable interpreter (probed
 * once, see PythonInterpreters); without one nothing runs and the user is
 * asked once to select it.
 */
export class PytestAdapter extends RunnerBackedAdapter {
  protected readonly displayName = 'pytest';
  private readonly _runnerAdapter = new PytestRunnerAdapter();

  async detect(projectRoot: string): Promise<boolean> {
    return this._runnerAdapter.detect(projectRoot);
  }

  override getFileGlob(): string {
    return '{**/test_*.py,**/*_test.py}';
  }

  /** `python_files` of the project (pytest's default `test_*.py` / `*_test.py`). */
  override isTestFile(filePath: string): boolean {
    if (!/\.py$/i.test(filePath)) { return false; }
    const name = filePath.split(/[\\/]/).pop() ?? '';
    return matchesPythonFile(name, this._pythonFiles);
  }

  private _pythonFiles: string[] | undefined;

  /** Re-read the config (a new session). */
  readConfig(projectRoot: string): void {
    this._pythonFiles = pytestSettings(projectRoot).pythonFiles;
  }

  // ── Runs wait for the interpreter ──────────────────────────────────────────

  override async discoverTests(projectRoot: string, rawLog: (msg: string) => void): Promise<string[]> {
    await pythonInterpreters().ensure(projectRoot);
    return super.discoverTests(projectRoot, rawLog);
  }

  override async listTestFiles(projectRoot: string, rawLog: (msg: string) => void): Promise<{ files: string[]; groups?: Record<string, string> }> {
    await pythonInterpreters().ensure(projectRoot);
    this.readConfig(projectRoot);
    return super.listTestFiles(projectRoot, rawLog);
  }

  override async runFile(store: ResultStore, filePath: string, projectRoot: string, rawLog: (msg: string) => void): Promise<'passed' | 'failed'> {
    try { await pythonInterpreters().ensure(projectRoot); } catch { return 'failed'; }
    return super.runFile(store, filePath, projectRoot, rawLog);
  }

  override async runTestCase(
    store: ResultStore,
    filePath: string,
    names: string[],
    projectRoot: string,
    rawLog: (msg: string) => void,
    opts?: RerunOptions,
  ): Promise<boolean> {
    try { await pythonInterpreters().ensure(projectRoot); } catch { return false; }
    return super.runTestCase(store, filePath, names, projectRoot, rawLog, opts);
  }

  /** Before the first coverage run there is nothing to find related tests with (covering tests come in 3.3). */
  override async runRelatedTests(): Promise<string[]> {
    this.log.debug('pytest has no related-tests run yet — a saved source file reruns nothing until covering tests are known');
    return [];
  }

  /** pytest selects by node id, never by a name pattern (see pytestNodeIds). */
  protected override runNamed(runner: CommandRunner, filePath: string, names: string[], isSuite: boolean) {
    return (runner as PytestRunner).runTestsByName(filePath, names, isSuite);
  }

  /**
   * The Python Debugger's launch: `python -m pytest <node id>` with the
   * project's interpreter, without our plugin, one process (`-n 0`), and
   * pytest-cov idle (a tracer would slow stepping).
   */
  async getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration> {
    registerProjectRoot(projectRoot);
    const { info } = await pythonInterpreters().ensure(projectRoot);
    if (!vscode.extensions.getExtension('ms-python.debugpy')) {
      void vscode.window.showWarningMessage(
        'Debugging pytest tests needs the Python Debugger extension (ms-python.debugpy).',
        'Install',
      ).then((choice) => {
        if (choice) { void vscode.commands.executeCommand('workbench.extensions.search', 'ms-python.debugpy'); }
      });
      throw new Error('the Python Debugger extension (ms-python.debugpy) is not installed');
    }
    const runner = this._createRunner(projectRoot, () => {}) as PytestRunner;
    return {
      type: 'debugpy',
      request: 'launch',
      name: 'Debug pytest test',
      module: 'pytest',
      args: runner.debugArgs(filePath, testFullName ? [testFullName] : undefined, isSuite),
      python: info.python,
      cwd: projectRoot,
      console: 'integratedTerminal',
      justMyCode: false,
      env: { PYTHONIOENCODING: 'utf-8' },
    };
  }

  protected createRunner(rawLog: (msg: string) => void): PytestRunner {
    return this._runnerAdapter.createRunner({
      command: '',
      logger: rawLog,
      tmpDir: this._tmpDir,
      pytestArgs: pytestArgsSetting(),
    }) as PytestRunner;
  }
}
