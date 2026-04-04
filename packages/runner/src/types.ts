// ── Framework ──────────────────────────────────────────────────────────────────

export type Framework = 'jest' | 'cra' | 'next' | 'vite' | 'unknown';
export type PackageManager = 'npm' | 'yarn' | 'pnpm';

// ── Simple test result (used internally for non-JSON runs) ────────────────────

export interface TestResult {
  passed: boolean;
  output: string;
  errors: string[];
}

// ── Structured Jest JSON output types ────────────────────────────────────────

export interface JestTestCaseResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped';
  duration?: number;
  failureMessages: string[];
  /** Source location reported by Jest (1-based line number) */
  location?: { line: number; column: number };
}

export interface JestConsoleEntry {
  message: string;
  /** Jest console type: 'log' | 'warn' | 'error' | 'info' | 'debug' | etc. */
  type: string;
  origin: string;
}

export interface JestFileResult {
  testFilePath: string;
  status: 'passed' | 'failed';
  testCases: JestTestCaseResult[];
  /** Console output captured during this file's run */
  consoleOutput: JestConsoleEntry[];
  /** Populated when the file itself fails to compile/parse */
  failureMessage?: string;
  /** Total execution time for this file in milliseconds */
  duration?: number;
}

export interface JestJsonResult {
  passed: boolean;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  fileResults: JestFileResult[];
  errors: string[];
}
