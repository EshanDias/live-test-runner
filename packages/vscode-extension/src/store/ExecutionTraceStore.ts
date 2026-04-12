/**
 * ExecutionTraceStore — stores execution trace data collected during instrumented test runs.
 *
 * Three data structures (per design plan):
 *
 * 1. traceIndex: Map<testId, string>
 *    Maps each test case's stable ID to the absolute path of its JSONL trace file.
 *    The trace file contains every Step executed during that test (including hooks).
 *
 * 2. coverageIndex: Map<filePath, Set<number>>
 *    Accumulates every line number executed in each source file across all tests.
 *    Never resets mid-session — only on clearAll().
 *    Used for session-wide gutter decorations on source files.
 *
 * 3. sourceToTests: Map<sourceFilePath, SourceTestMapping>
 *    Maps each source file to the test suites that cover it, including whether
 *    those suites have shared variables across test cases (isSharedVars).
 *    Used to determine run scope when a source file is saved.
 *
 * testId convention: full test name — "describe title > nested > test name"
 * (same key Jest uses for --testNamePattern, same as ResultStore).
 */

export interface SuiteTraceInfo {
  isSharedVars: boolean;
  sharedVarNames: string[];   // variable names detected as shared (for display)
  testCases: string[];        // full test names in this suite
}

export interface SourceTestMapping {
  [testFilePath: string]: {
    [suiteName: string]: SuiteTraceInfo;
  };
}

export class ExecutionTraceStore {
  /** testId → absolute path to the test's JSONL trace file */
  private readonly _traceIndex = new Map<string, string>();

  /** filePath → set of line numbers executed across all tests in the session */
  private readonly _coverageIndex = new Map<string, Set<number>>();

  /** sourceFilePath → test file → suite → trace metadata */
  private readonly _sourceToTests = new Map<string, SourceTestMapping>();

  // ── Trace index ────────────────────────────────────────────────────────────

  setTraceFile(testId: string, filePath: string): void {
    this._traceIndex.set(testId, filePath);
  }

  getTraceFile(testId: string): string | undefined {
    return this._traceIndex.get(testId);
  }

  hasTraceFile(testId: string): boolean {
    return this._traceIndex.has(testId);
  }

  getAllTracedTestIds(): string[] {
    return Array.from(this._traceIndex.keys());
  }

  // ── Coverage index ─────────────────────────────────────────────────────────

  /**
   * Record that a set of lines executed in a source file.
   * Accumulates — never clears individual entries mid-session.
   */
  addCoveredLines(filePath: string, lines: number[]): void {
    let set = this._coverageIndex.get(filePath);
    if (!set) {
      set = new Set<number>();
      this._coverageIndex.set(filePath, set);
    }
    for (const line of lines) { set.add(line); }
  }

  getCoveredLines(filePath: string): Set<number> {
    return this._coverageIndex.get(filePath) ?? new Set();
  }

  getAllCoveredFiles(): string[] {
    return Array.from(this._coverageIndex.keys());
  }

  // ── Source → test mapping ──────────────────────────────────────────────────

  setSourceMapping(sourceFilePath: string, mapping: SourceTestMapping): void {
    this._sourceToTests.set(sourceFilePath, mapping);
  }

  getSourceMapping(sourceFilePath: string): SourceTestMapping | undefined {
    return this._sourceToTests.get(sourceFilePath);
  }

  /**
   * Returns all test file paths that import / depend on the given source file.
   * Used by SessionManager when a source file is saved.
   */
  getAffectedTestFiles(sourceFilePath: string): string[] {
    const mapping = this._sourceToTests.get(sourceFilePath);
    if (!mapping) { return []; }
    return Object.keys(mapping);
  }

  /**
   * For a given source file + test file, return the suites that have shared vars.
   * Used to decide whether to run just one test or the whole suite on rerun.
   */
  getSuiteInfo(sourceFilePath: string, testFilePath: string): { [suite: string]: SuiteTraceInfo } {
    return this._sourceToTests.get(sourceFilePath)?.[testFilePath] ?? {};
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  dump(): string {
    const lines: string[] = [];

    lines.push('=== ExecutionTraceStore dump ===\n');

    lines.push(`--- traceIndex (${this._traceIndex.size} entries) ---`);
    for (const [testId, filePath] of this._traceIndex) {
      lines.push(`  "${testId}" → ${filePath}`);
    }

    lines.push(`\n--- coverageIndex (${this._coverageIndex.size} source files) ---`);
    for (const [filePath, lines_] of this._coverageIndex) {
      lines.push(`  ${filePath}: ${lines_.size} lines covered`);
    }

    lines.push(`\n--- sourceToTests (${this._sourceToTests.size} source files) ---`);
    for (const [sourceFile, mapping] of this._sourceToTests) {
      lines.push(`  [source] ${sourceFile}`);
      for (const [testFile, suites] of Object.entries(mapping)) {
        lines.push(`    [test file] ${testFile}`);
        for (const [suiteName, info] of Object.entries(suites)) {
          lines.push(`      [suite] "${suiteName}" isSharedVars=${info.isSharedVars}`);
          for (const tc of info.testCases) {
            lines.push(`        - "${tc}"`);
          }
        }
      }
    }

    lines.push('\n=== end dump ===');
    return lines.join('\n');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Clear all data. Called when a new session starts (before starting the fresh run).
   * Trace files on disk are deleted by SessionTraceRunner / extension cleanup separately.
   */
  clearAll(): void {
    this._traceIndex.clear();
    this._coverageIndex.clear();
    this._sourceToTests.clear();
  }
}
