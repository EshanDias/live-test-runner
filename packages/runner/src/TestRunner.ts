import { RunResult } from './types';

/** What a framework adapter needs to create its {@link TestRunner}. */
export interface RunnerOptions {
  /** User command override (e.g. `liveTestRunner.jestCommand`, or `npm test --`); '' = resolve the local install. */
  command?: string;
  /** Sink for raw test-runner output lines (the "Test Output" channel). */
  logger?: (msg: string) => void;
  /** Directory for temporary result files (the session dir). */
  tmpDir?: string;
  /** Vitest: also run browser-mode projects (they need Playwright / WebdriverIO browsers). Default false. */
  includeBrowserProjects?: boolean;
}

/**
 * Framework-agnostic test runner interface.
 *
 * Any framework implementation (Jest, Vitest, etc.) implements this contract.
 * The extension layer only depends on this interface — never on concrete runner classes.
 */
export interface TestRunner {
  /** Wire in a logger for real-time stdout/stderr streaming. */
  setLogger(logger: (msg: string) => void): void;

  /** Set the project root. Must be called before any run methods. */
  setProjectRoot(root: string): void;

  /** Return all test file paths known to this framework. */
  discoverTests(projectRoot: string): Promise<string[]>;

  /** Run every test file and return structured per-file/per-case results. */
  runFullSuiteJson(
    projectRoot: string,
    withCoverage?: boolean,
  ): Promise<RunResult>;

  /** Run a single test file and return structured results. */
  runTestFileJson(filePath: string): Promise<RunResult>;

  /** Run multiple test files in one invocation and return merged structured results. */
  runTestFilesJson(filePaths: string[]): Promise<RunResult>;

  /** Run a single named test within a file using a name pattern match. */
  runTestCaseJson(
    filePath: string,
    testFullName: string,
    isTestSuite?: boolean,
  ): Promise<RunResult>;

  /** Run tests related to a source file and return structured results. */
  runRelatedTestsJson(filePath: string): Promise<RunResult>;

  /** Returns true if the given path is a test file (not a source file). */
  isTestFile(filePath: string): boolean;

  /** Read coverage output produced by the last run (returns empty object if unavailable). */
  getCoverage(): Promise<Record<string, unknown>>;

  /** Kill any running child processes immediately. */
  killProcesses(): void;
}
