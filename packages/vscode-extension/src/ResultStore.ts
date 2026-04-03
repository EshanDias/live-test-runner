/**
 * ResultStore — typed in-memory result tree for the custom UI.
 *
 * Hierarchy: File → Suite → Test case
 * All IDs are stable string keys derived from file path / suite name / test name.
 */

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export type OutputLevel = 'log' | 'info' | 'warn' | 'error';

export interface OutputLine {
  text: string;
  level: OutputLevel;
}

export interface TestCaseResult {
  testId: string;       // `${fileId}::${suiteId}::${testName}`
  name: string;
  status: TestStatus;
  duration?: number;
  outputLines: OutputLine[];
  failureMessages: string[];
}

export interface SuiteResult {
  suiteId: string;      // `${fileId}::${suiteName}`
  name: string;
  status: TestStatus;
  duration?: number;
  tests: Map<string, TestCaseResult>;
}

export interface FileResult {
  fileId: string;       // absolute file path
  filePath: string;
  name: string;         // relative display name
  status: TestStatus;
  duration?: number;
  /** Console output captured during this file's run (from Jest --json `console` array) */
  outputLines: OutputLine[];
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
      outputLines: [],
      suites: new Map(),
    });
  }

  /** Store file-level console output captured by Jest (cannot be scoped to individual tests). */
  fileOutput(fileId: string, lines: OutputLine[]): void {
    const file = this.files.get(fileId);
    if (!file) return;
    file.outputLines = lines;
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
    });
  }

  suiteResult(fileId: string, suiteId: string, status: TestStatus, duration?: number): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.status = status;
    suite.duration = duration;
  }

  testStarted(fileId: string, suiteId: string, testId: string, name: string): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.tests.set(testId, {
      testId,
      name,
      status: 'running',
      outputLines: [],
      failureMessages: [],
    });
  }

  testOutput(fileId: string, suiteId: string, testId: string, text: string, level: OutputLevel): void {
    const test = this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
    if (!test) return;
    test.outputLines.push({ text, level });
  }

  testResult(
    fileId: string,
    suiteId: string,
    testId: string,
    status: TestStatus,
    duration?: number,
    failureMessages: string[] = []
  ): void {
    const test = this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
    if (!test) return;
    test.status = status;
    test.duration = duration;
    test.failureMessages = failureMessages;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getFile(fileId: string): FileResult | undefined {
    return this.files.get(fileId);
  }

  getSuite(fileId: string, suiteId: string): SuiteResult | undefined {
    return this.files.get(fileId)?.suites.get(suiteId);
  }

  getTest(fileId: string, suiteId: string, testId: string): TestCaseResult | undefined {
    return this.files.get(fileId)?.suites.get(suiteId)?.tests.get(testId);
  }

  getAllFiles(): FileResult[] {
    return Array.from(this.files.values());
  }

  getSummary(): { total: number; passed: number; failed: number; running: number } {
    let total = 0, passed = 0, failed = 0, running = 0;
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

  /** Returns output lines scoped to the given selection.
   *  Console output is captured at file level by Jest JSON, so file/suite scope returns
   *  file.outputLines. Test scope returns the test's own outputLines (populated via testOutput()).
   */
  getOutputLines(
    fileId: string,
    suiteId?: string,
    testId?: string
  ): OutputLine[] {
    const file = this.files.get(fileId);
    if (!file) return [];

    if (testId && suiteId) {
      // Per-test lines if available, fall back to file-level console output
      const testLines = file.suites.get(suiteId)?.tests.get(testId)?.outputLines ?? [];
      return testLines.length > 0 ? testLines : file.outputLines;
    }
    // Suite or file scope — return file-level console output
    return file.outputLines;
  }

  /** Returns all failure messages scoped to the given selection. */
  getFailureMessages(
    fileId: string,
    suiteId?: string,
    testId?: string
  ): string[] {
    const file = this.files.get(fileId);
    if (!file) return [];

    if (testId && suiteId) {
      return file.suites.get(suiteId)?.tests.get(testId)?.failureMessages ?? [];
    }
    if (suiteId) {
      const suite = file.suites.get(suiteId);
      if (!suite) return [];
      return Array.from(suite.tests.values()).flatMap(t => t.failureMessages);
    }
    return Array.from(file.suites.values()).flatMap(s =>
      Array.from(s.tests.values()).flatMap(t => t.failureMessages)
    );
  }

  /** Serialises the full tree to a plain object safe to post to a webview. */
  toJSON(): object {
    const files = Array.from(this.files.values()).map(f => ({
      fileId: f.fileId,
      filePath: f.filePath,
      name: f.name,
      status: f.status,
      duration: f.duration,
      suites: Array.from(f.suites.values()).map(s => ({
        suiteId: s.suiteId,
        name: s.name,
        status: s.status,
        duration: s.duration,
        tests: Array.from(s.tests.values()).map(t => ({
          testId: t.testId,
          name: t.name,
          status: t.status,
          duration: t.duration,
          failureMessages: t.failureMessages,
          // outputLines omitted from full tree — fetched on demand via scope-changed
        })),
      })),
    }));
    return { files };
  }
}
