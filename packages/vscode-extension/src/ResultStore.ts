/**
 * ResultStore — typed in-memory result tree for the custom UI.
 *
 * Hierarchy: File → Suite → Test case
 * All IDs are stable string keys derived from file path / suite name / test name.
 */

export type TestStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped';

export type OutputLevel = 'log' | 'info' | 'warn' | 'error';

export interface OutputLine {
  text: string;
  level: OutputLevel;
  timestamp: number;
}

export interface ScopedOutput {
  lines: OutputLine[];
  /** Date.now() when this batch was stored. null = never run at this scope. */
  capturedAt: number | null;
}

const EMPTY_OUTPUT: ScopedOutput = { lines: [], capturedAt: null };

export interface TestCaseResult {
  testId: string; // `${fileId}::${suiteId}::${testName}`
  name: string;
  /** Jest fullName — ancestor suite titles + test title, used for --testNamePattern */
  fullName: string;
  status: TestStatus;
  duration?: number;
  output: ScopedOutput;
  failureMessages: string[];
}

export interface SuiteResult {
  suiteId: string; // `${fileId}::${suiteName}`
  name: string;
  status: TestStatus;
  duration?: number;
  tests: Map<string, TestCaseResult>;
  output: ScopedOutput;
}

export interface FileResult {
  fileId: string; // absolute file path
  filePath: string;
  name: string; // relative display name
  status: TestStatus;
  duration?: number;
  /** Console output captured during this file's run (from Jest --json `console` array) */
  output: ScopedOutput;
  suites: Map<string, SuiteResult>;
}

export class ResultStore {
  private files: Map<string, FileResult> = new Map();

  // ── Mutations ──────────────────────────────────────────────────────────────

  clear(): void {
    this.files.clear();
  }

  fileStarted(fileId: string, filePath: string, name: string): void {
    this.files.set(fileId, {
      fileId,
      filePath,
      name,
      status: 'running',
      output: { lines: [], capturedAt: null },
      suites: new Map(),
    });
  }

  fileResult(fileId: string, status: TestStatus, duration?: number): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.status = status;
    file.duration = duration;
  }

  suiteStarted(fileId: string, suiteId: string, name: string): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.suites.set(suiteId, {
      suiteId,
      name,
      status: 'running',
      tests: new Map(),
      output: { lines: [], capturedAt: null },
    });
  }

  suiteResult(
    fileId: string,
    suiteId: string,
    status: TestStatus,
    duration?: number,
  ): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.status = status;
    suite.duration = duration;
  }

  testStarted(
    fileId: string,
    suiteId: string,
    testId: string,
    name: string,
    fullName: string,
  ): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.tests.set(testId, {
      testId,
      name,
      fullName,
      status: 'running',
      output: { lines: [], capturedAt: null },
      failureMessages: [],
    });
  }

  testResult(
    fileId: string,
    suiteId: string,
    testId: string,
    status: TestStatus,
    duration?: number,
    failureMessages: string[] = [],
  ): void {
    const test = this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
    if (!test) return;
    test.status = status;
    test.duration = duration;
    test.failureMessages = failureMessages;
  }

  // ── Scoped output setters ──────────────────────────────────────────────────

  setFileOutput(fileId: string, output: ScopedOutput): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.output = output;
  }

  setSuiteOutput(fileId: string, suiteId: string, output: ScopedOutput): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.output = output;
  }

  setTestOutput(
    fileId: string,
    suiteId: string,
    testId: string,
    output: ScopedOutput,
  ): void {
    const test = this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
    if (!test) return;
    test.output = output;
  }

  // ── Scoped output getters ──────────────────────────────────────────────────

  getFileOutput(fileId: string): ScopedOutput {
    return this.files.get(fileId)?.output ?? EMPTY_OUTPUT;
  }

  getSuiteOutput(fileId: string, suiteId: string): ScopedOutput {
    return this.files.get(fileId)?.suites.get(suiteId)?.output ?? EMPTY_OUTPUT;
  }

  getTestOutput(fileId: string, suiteId: string, testId: string): ScopedOutput {
    return (
      this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId)?.output ??
      EMPTY_OUTPUT
    );
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getFile(fileId: string): FileResult | undefined {
    return this.files.get(fileId);
  }

  getSuite(fileId: string, suiteId: string): SuiteResult | undefined {
    return this.files.get(fileId)?.suites.get(suiteId);
  }

  getTest(
    fileId: string,
    suiteId: string,
    testId: string,
  ): TestCaseResult | undefined {
    return this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
  }

  getAllFiles(): FileResult[] {
    return Array.from(this.files.values());
  }

  getSummary(): {
    total: number;
    passed: number;
    failed: number;
    running: number;
  } {
    let total = 0,
      passed = 0,
      failed = 0,
      running = 0;
    for (const file of this.files.values()) {
      for (const suite of file.suites.values()) {
        for (const test of suite.tests.values()) {
          total++;
          if (test.status === 'passed') passed++;
          else if (test.status === 'failed') failed++;
          else if (test.status === 'running') running++;
        }
      }
    }
    return { total, passed, failed, running };
  }

  /** Serialises the full tree to a plain object safe to post to a webview. */
  toJSON(): object {
    const files = Array.from(this.files.values()).map((f) => ({
      fileId: f.fileId,
      filePath: f.filePath,
      name: f.name,
      status: f.status,
      duration: f.duration,
      suites: Array.from(f.suites.values()).map((s) => ({
        suiteId: s.suiteId,
        name: s.name,
        status: s.status,
        duration: s.duration,
        tests: Array.from(s.tests.values()).map((t) => ({
          testId: t.testId,
          name: t.name,
          fullName: t.fullName,
          status: t.status,
          duration: t.duration,
          failureMessages: t.failureMessages,
          // output omitted — fetched on demand via scope-logs
        })),
      })),
    }));
    return { files };
  }
}
