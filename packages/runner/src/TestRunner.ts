import { JestJsonResult } from './types';

/**
 * Framework-agnostic test runner interface.
 *
 * Any framework adapter (Jest, Vitest, etc.) implements this contract.
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
  runFullSuiteJson(projectRoot: string, withCoverage?: boolean): Promise<JestJsonResult>;

  /** Run a single test file and return structured results. */
  runTestFileJson(filePath: string): Promise<JestJsonResult>;

  /** Run multiple test files in one invocation and return merged structured results. */
  runTestFilesJson(filePaths: string[]): Promise<JestJsonResult>;

  /** Run a single named test within a file using --testNamePattern. */
  runTestCaseJson(filePath: string, testFullName: string): Promise<JestJsonResult>;

  /** Run tests related to a source file (e.g. --findRelatedTests) and return structured results. */
  runRelatedTestsJson(filePath: string): Promise<JestJsonResult>;

  /** Returns true if the given path is a test file (not a source file). */
  isTestFile(filePath: string): boolean;

  /** Read coverage output produced by the last run (returns empty object if unavailable). */
  getCoverage(): Promise<Record<string, unknown>>;

  /** Kill any running child processes immediately. */
  killProcesses(): void;
}
