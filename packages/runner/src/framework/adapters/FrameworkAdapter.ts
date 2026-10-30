import { FrameworkCapabilities, FrameworkId, RunResult } from '../../types';
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
 * Adding a new framework = implementing this interface + registering it in FrameworkRegistry.
 */
/**
 * The language a framework runs. Projects of different families never
 * swallow each other (a Python project inside a JS project's folder stays a
 * project of its own), and each family has its own binary rules.
 */
export type FrameworkFamily = 'js' | 'python';

export interface FrameworkAdapter {
  readonly framework: FrameworkId;

  /** The language family (default `js`). */
  readonly family?: FrameworkFamily;

  /** Returns true if this adapter handles the given project root. */
  detect(projectRoot: string): boolean;

  /**
   * The program to spawn: a JS entry point (run with Node — it must come
   * from the project's own node_modules, never a global install) or an
   * absolute executable (pytest: the project's Python interpreter, spawned
   * directly without a shell).
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

  /**
   * What the framework, at the version installed in `projectRoot`, can do.
   * Must not throw — a missing install reports the capabilities of a current version.
   */
  capabilities(projectRoot: string): FrameworkCapabilities;

  /** The TestRunner that runs this framework's tests. */
  createRunner(options?: RunnerOptions): TestRunner;
}
