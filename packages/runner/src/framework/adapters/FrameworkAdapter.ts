import { Framework } from '../../types';

/**
 * A FrameworkAdapter encapsulates everything that differs between test frameworks:
 *  - How to detect the framework from a project
 *  - Where the test runner binary lives
 *  - How to resolve or extract the framework config
 *  - Any framework-specific CLI args
 *
 * Adding a new framework = implementing this interface + registering it in FrameworkDetector.
 */
export interface FrameworkAdapter {
  readonly framework: Framework;

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
}
