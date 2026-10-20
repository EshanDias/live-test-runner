import { FrameworkId, RunResult } from '../../types';
import { RunnerOptions, TestRunner } from '../../TestRunner';

/**
 * A FrameworkAdapter encapsulates everything that differs between test frameworks:
 *  - How to detect the framework from a project
 *  - Where the test runner binary lives
 *  - How to resolve or extract the framework config
 *  - Any framework-specific CLI args
 *
 *  - How it writes and how to read its JSON result
 *  - Which TestRunner builds its command lines
 *
 * Adding a new framework = implementing this interface + registering it in FrameworkDetector.
 */
export interface FrameworkAdapter {
  readonly framework: FrameworkId;

  /** Returns true if this adapter handles the given project root. */
  detect(projectRoot: string): boolean;

  /**
   * Resolves the absolute path to the test runner binary.
   * Must use the project's local node_modules — never assume a global install.
   */
  resolveBinary(projectRoot: string): string;

  /**
   * Resolves the path to a config file to pass via --config.
   * Returns undefined when the framework should discover its own config.
   *
   * Implementations may write a temporary config file (e.g. for CRA) and return its path.
   * The returned path is owned by the caller — do NOT delete it inside this method.
   */
  resolveConfig(projectRoot: string): Promise<string | undefined>;

  /**
   * Extra CLI args specific to this framework, inserted before the common base args.
   * Example: CRA may need specific env vars; Vite/Vitest needs its own flags.
   */
  getExtraArgs(projectRoot: string): string[];

  /** Args that make the runner write its JSON result to `file` (Jest: `--outputFile=<file>`). */
  outputFileArg(file: string): string[];

  /**
   * Turns the runner's raw JSON result into a RunResult.
   *
   * @param passed whether the process exited with code 0
   * @param raw    the JSON text (from the output file, or stdout as a fallback)
   * @param stderr the process's stderr (some frameworks only print console output there)
   */
  parseResult(passed: boolean, raw: string, stderr: string): RunResult;

  /** The TestRunner that runs this framework's tests. */
  createRunner(options?: RunnerOptions): TestRunner;
}
