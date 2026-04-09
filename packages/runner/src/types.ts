// ── Framework ──────────────────────────────────────────────────────────────────

export type Framework = 'jest' | 'cra' | 'next' | 'vite' | 'unknown';
export type PackageManager = 'npm' | 'yarn' | 'pnpm';

// ── Simple test result (used internally for non-JSON runs) ────────────────────

export interface TestResult {
  passed: boolean;
  output: string;
  errors: string[];
}

// ── Structured runner output types ───────────────────────────────────────────
//
// These are the normalised result types returned by any framework adapter after
// a test run. They are framework-agnostic: JestRunner, a future VitestRunner,
// or any other runner all produce these same shapes.

export interface TestCaseRunResult {
  ancestorTitles: string[];
  title: string;
  /** Full display name including all ancestor suite titles */
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped';
  duration?: number;
  failureMessages: string[];
  /** 1-based source location reported by the framework (requires framework support) */
  location?: { line: number; column: number };
}

export interface ConsoleEntry {
  message: string;
  /** Console level: 'log' | 'warn' | 'error' | 'info' | 'debug' | etc. */
  type: string;
  origin: string;
}

export interface FileRunResult {
  testFilePath: string;
  status: 'passed' | 'failed';
  testCases: TestCaseRunResult[];
  /** Console output captured during this file's run */
  consoleOutput: ConsoleEntry[];
  /** Populated when the file itself fails to compile/parse */
  failureMessage?: string;
  /** Total execution time for this file in milliseconds */
  duration?: number;
}

export interface RunResult {
  passed: boolean;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  fileResults: FileRunResult[];
  errors: string[];
}

// ── Backward-compatible aliases ───────────────────────────────────────────────
// These keep existing imports working during any gradual migration.

/** @deprecated Use RunResult */
export type JestJsonResult = RunResult;
/** @deprecated Use FileRunResult */
export type JestFileResult = FileRunResult;
/** @deprecated Use TestCaseRunResult */
export type JestTestCaseResult = TestCaseRunResult;
/** @deprecated Use ConsoleEntry */
export type JestConsoleEntry = ConsoleEntry;
