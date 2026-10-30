import { FRAMEWORK_IDS, FrameworkCapabilities, FrameworkId, RunResult } from '../../types';
import { RunnerOptions, TestRunner } from '../../TestRunner';
import { FrameworkAdapter, FrameworkFamily } from './FrameworkAdapter';
import { PytestRunner, pytestExitReason } from '../../PytestRunner';
import { isPytestProject } from '../pytest/pytestConfig';
import { pythonFor } from '../pytest/python';
import { fromRunnerPath } from '../../resolution/RunnerPaths';
import { tail } from '../../execution/Executor';
import { createLogger } from '../../utils/logger';

const log = createLogger('PytestAdapter');

/**
 * Handles pytest projects (Python).
 *
 * Detection: a pytest config (`pytest.toml` / `pytest.ini` / `pyproject.toml`
 * `[tool.pytest…]` / `tox.ini [pytest]` / `setup.cfg [tool:pytest]`), a root
 * `conftest.py`, or pytest named in the dependency files next to test files.
 * Registered below the JS adapters: a folder a JS framework claims stays JS.
 *
 * Binary: the project's Python interpreter, chosen and probed by the
 * extension (python.ts) — spawned directly, no shell, no activation.
 * Results: our plugin writes them (`--ltr-result=<file>`) in the runner's own
 * shapes, so parsing is reading JSON.
 */
export class PytestAdapter implements FrameworkAdapter {
  readonly framework: FrameworkId = FRAMEWORK_IDS.pytest;
  readonly family: FrameworkFamily = 'python';

  detect(projectRoot: string): boolean {
    return isPytestProject(projectRoot);
  }

  resolveBinary(projectRoot: string): string {
    const info = pythonFor(projectRoot);
    if (!info) {
      const msg =
        `[Live Test Runner] No Python interpreter is selected for ${projectRoot}. ` +
        'Run "Live Test Runner: Select Python Interpreter" or set liveTestRunner.pythonPath.';
      log.error(msg);
      throw new Error(msg);
    }
    return info.python;
  }

  /** pytest finds its own config (rootdir / inifile rules); passing `-c` would change rootdir. */
  async resolveConfig(_projectRoot: string): Promise<string | undefined> {
    return undefined;
  }

  getExtraArgs(_projectRoot: string): string[] {
    return [];
  }

  outputFileArg(file: string): string[] {
    return [`--ltr-result=${file}`];
  }

  parseResult(passed: boolean, raw: string, stderr: string): RunResult {
    const text = raw.trim();
    if (text.startsWith('{')) {
      try {
        const r = JSON.parse(text) as RunResult & { exitStatus?: number };
        const reason = pytestExitReason(r.exitStatus);
        if (reason) { log.warn(`${reason}. pytest said:\n${tail(stderr, 15)}`); }
        return {
          passed: r.passed,
          numPassedTests: r.numPassedTests ?? 0,
          numFailedTests: r.numFailedTests ?? 0,
          numPendingTests: r.numPendingTests ?? 0,
          errors: r.errors ?? [],
          fileResults: (r.fileResults ?? []).map((f) => ({ ...f, testFilePath: fromRunnerPath(f.testFilePath) })),
        };
      } catch (err) {
        log.warn(`Could not read the pytest result: ${(err as Error).message}`);
      }
    }
    // No result: pytest stopped before the session finished (a usage error, a broken conftest.py).
    const message = `pytest produced no result${passed ? '' : ' (it exited with an error)'}. pytest said:\n${tail(stderr || raw, 20)}`;
    log.warn(message);
    return { passed: false, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, fileResults: [], errors: [message] };
  }

  capabilities(projectRoot: string): FrameworkCapabilities {
    return {
      results: true,
      nameFilter: true,
      listTests: true,
      // Related tests come from coverage contexts in the extension, not from pytest.
      related: false,
      liveStream: true,
      coverage: !!pythonFor(projectRoot)?.coverage,
    };
  }

  createRunner(options: RunnerOptions = {}): TestRunner {
    return new PytestRunner(options.command ?? '', options.logger, options.tmpDir, options.pytestArgs ?? []);
  }
}
