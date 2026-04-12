/**
 * ResultStore — typed in-memory result tree for the custom UI.
 *
 * Intentionally has no VS Code or framework imports — it is pure data.
 * The extension layer writes to it (via JestAdapter._applyFileResult) and
 * reads from it (via views and DecorationManager).
 *
 * Hierarchy: File → Suite → Test case
 * All IDs are stable string keys derived from file path / suite name / test name.
 */

/** Location index only — status and duration are read live from the result tree. */
export type LineEntry = {
  testId?: string; // absent for describe-level entries
  suiteId: string;
  fileId: string;
};

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
  /** Full display name including ancestor suite titles — used to scope reruns by name pattern */
  fullName: string;
  status: TestStatus;
  duration?: number;
  /** 1-based source line reported by the framework, used for editor gutter decorations */
  line?: number;
  output: ScopedOutput;
  failureMessages: string[];
}

export interface SuiteResult {
  suiteId: string; // `${fileId}::${suiteName}`
  name: string;
  status: TestStatus;
  duration?: number;
  /** 1-based source line of the describe() call, used for open-file navigation */
  line?: number;
  tests: Map<string, TestCaseResult>;
  output: ScopedOutput;
}

export interface FileResult {
  fileId: string; // absolute file path
  filePath: string;
  name: string; // relative display name
  status: TestStatus;
  duration?: number;
  /** Console output captured during this file's run */
  output: ScopedOutput;
  suites: Map<string, SuiteResult>;
}

export class ResultStore {
  private files: Map<string, FileResult> = new Map();
  // key: absolute filePath → Map<1-based lineNumber, LineEntry>
  private _lineMap: Map<string, Map<number, LineEntry>> = new Map();

  // ── Mutations ──────────────────────────────────────────────────────────────

  clear(): void {
    this.files.clear();
  }

  /**
   * Removes a single file entry and its line map. Used by TestDiscoveryService
   * to force a fresh re-discovery of a file that has only pending results.
   */
  removeFile(fileId: string): void {
    this.files.delete(fileId);
    this._lineMap.delete(fileId);
  }

  // ── LineMap ────────────────────────────────────────────────────────────────

  setLineEntry(filePath: string, line: number, entry: LineEntry): void {
    if (!this._lineMap.has(filePath)) {
      this._lineMap.set(filePath, new Map());
    }
    this._lineMap.get(filePath)!.set(line, entry);
  }

  getLineMap(filePath: string): Map<number, LineEntry> {
    return this._lineMap.get(filePath) ?? new Map();
  }

  clearLineMap(filePath: string): void {
    this._lineMap.delete(filePath);
  }

  clearAllLineMaps(): void {
    this._lineMap.clear();
  }

  /** Set all tests in a file to 'running' so the editor decorations show the spinner. */
  markTestsRunning(filePath: string, suiteId?: string, testId?: string): void {
    const file = this.files.get(filePath);
    if (!file) {
      return;
    }
    file.status = 'running';
    for (const suite of file.suites.values()) {
      if (!!suiteId && suite.suiteId !== suiteId) {
        continue;
      }
      suite.status = 'running';
      for (const test of suite.tests.values()) {
        if (!!testId && test.testId !== testId) {
          continue;
        }
        test.status = 'running';
      }
    }
  }

  /**
   * Pre-populate a file entry from static discovery (before any run).
   * No-ops if the file is already present so live results are never overwritten.
   */
  fileDiscovered(fileId: string, filePath: string, name: string): void {
    if (this.files.has(fileId)) {
      return;
    }
    this.files.set(fileId, {
      fileId,
      filePath,
      name,
      status: 'pending',
      output: { lines: [], capturedAt: null },
      suites: new Map(),
    });
  }

  /**
   * Pre-populate a suite entry from static discovery.
   * No-ops if the suite is already present.
   */
  suiteDiscovered(
    fileId: string,
    suiteId: string,
    name: string,
    line?: number,
  ): void {
    const file = this.files.get(fileId);
    if (!file || file.suites.has(suiteId)) {
      return;
    }
    file.suites.set(suiteId, {
      suiteId,
      name,
      status: 'pending',
      line,
      tests: new Map(),
      output: { lines: [], capturedAt: null },
    });
  }

  /**
   * Pre-populate a test entry from static discovery.
   * No-ops if the test is already present.
   * `line` is the 1-based source line from the AST, used for editor gutter decorations.
   */
  testDiscovered(
    fileId: string,
    suiteId: string,
    testId: string,
    name: string,
    fullName: string,
    line?: number,
  ): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite || suite.tests.has(testId)) {
      return;
    }
    suite.tests.set(testId, {
      testId,
      name,
      fullName,
      status: 'pending',
      line,
      output: { lines: [], capturedAt: null },
      failureMessages: [],
    });
  }

  removePendingPlaceholders(fileId: string): void {
    const file = this.files.get(fileId);
    if (!file) {
      return;
    }
    for (const suite of file.suites.values()) {
      for (const [testId, test] of suite.tests) {
        if (
          (test.status === 'pending' || test.status === 'running') &&
          (test.name === '…' || test.name.includes('…'))
        ) {
          suite.tests.delete(testId);
        }
      }
    }
  }

  fileStarted(fileId: string, filePath: string, name: string): void {
    const existing = this.files.get(fileId);
    if (existing) {
      // File was pre-populated by static discovery — preserve the suite/test
      // structure so the UI keeps showing the tree while the run is in progress.
      existing.status = 'running';
      existing.output = { lines: [], capturedAt: null };
      this.markTestsRunning(filePath);
    } else {
      this.files.set(fileId, {
        fileId,
        filePath,
        name,
        status: 'running',
        output: { lines: [], capturedAt: null },
        suites: new Map(),
      });
    }
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
    line?: number,
  ): void {
    const suite = this.files.get(fileId)?.suites.get(suiteId);
    if (!suite) return;
    suite.tests.set(testId, {
      testId,
      name,
      fullName,
      status: 'running',
      line,
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
    totalDuration: number;
  } {
    let total = 0,
      passed = 0,
      failed = 0,
      running = 0,
      totalDuration = 0;
    for (const file of this.files.values()) {
      totalDuration += file.duration ?? 0;
      for (const suite of file.suites.values()) {
        for (const test of suite.tests.values()) {
          total++;
          if (test.status === 'passed') passed++;
          else if (test.status === 'failed') failed++;
          else if (test.status === 'running') running++;
        }
      }
    }
    return { total, passed, failed, running, totalDuration };
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
        line: s.line,
        tests: Array.from(s.tests.values()).map((t) => ({
          testId: t.testId,
          name: t.name,
          fullName: t.fullName,
          status: t.status,
          duration: t.duration,
          line: t.line,
          failureMessages: t.failureMessages,
          // output omitted — fetched on demand via scope-logs
        })),
      })),
    }));
    return { files };
  }
}
