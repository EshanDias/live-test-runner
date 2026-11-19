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

export interface LineTestEntry {
  /** Absolute path to the test file containing this test */
  testFileId: string;
  /** Full test name — "suite > nested > test" — matches ResultStore node.fullName */
  fullName: string;
}

export class ExecutionTraceStore {
  /** testId → absolute path to the test's JSONL trace file */
  private readonly _traceIndex = new Map<string, string>();

  /** filePath → set of line numbers executed across all tests in the session */
  private readonly _coverageIndex = new Map<string, Set<number>>();

  /** sourceFilePath → test file → suite → trace metadata */
  private readonly _sourceToTests = new Map<string, SourceTestMapping>();

  /**
   * Line → test reverse index.
   * sourceFilePath → lineNumber (1-based) → test file → full test names.
   * Used by CoverageHoverProvider to show "covered by N tests" on gutter hover.
   * Kept per test file so adding or forgetting one costs only its own lines
   * (a flat list per line made every batch scan every earlier test of a
   * shared component: Sentry's 2,500 test files took 605 s on the extension host).
   */
  private readonly _lineToTests = new Map<string, Map<number, Map<string, string[]>>>();

  /**
   * Module graph (Vitest): file → the project files that import it, any
   * file type (`?raw` imports, files a plugin reads — Angular templates).
   * Lets a save of a file no test *ran* (no lines: HTML, CSS modules,
   * templates) rerun the test files that load it.
   */
  private readonly _importers = new Map<string, Set<string>>();

  /** Test file → the source files its entries name (sourceToTests, lineToTests): what forgetTestFiles visits. */
  private readonly _sourcesOfTestFile = new Map<string, Set<string>>();

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
    for (const tf of Object.keys(mapping)) { this._noteSource(tf, sourceFilePath); }
  }

  /** One test file's suites for a source file (the other test files' entries untouched). */
  setSourceTests(sourceFilePath: string, testFilePath: string, suites: { [suiteName: string]: SuiteTraceInfo }): void {
    let mapping = this._sourceToTests.get(sourceFilePath);
    if (!mapping) { mapping = {}; this._sourceToTests.set(sourceFilePath, mapping); }
    mapping[testFilePath] = suites;
    this._noteSource(testFilePath, sourceFilePath);
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

  /** Module graph: `importers` import `filePath` (merged across batches). */
  addImporters(filePath: string, importers: string[]): void {
    let set = this._importers.get(filePath);
    if (!set) { set = new Set(); this._importers.set(filePath, set); }
    for (const i of importers) { set.add(i); }
  }

  /** A test loaded this file (it is in the module graph). */
  isLoaded(filePath: string): boolean {
    return this._importers.has(filePath);
  }

  /** The test files that (transitively) import `filePath`, by the module graph. */
  getDependentTestFiles(filePath: string, isTestFile: (fp: string) => boolean): string[] {
    const found = new Set<string>();
    const seen = new Set<string>([filePath]);
    const queue = [filePath];
    while (queue.length > 0) {
      const f = queue.shift()!;
      for (const imp of this._importers.get(f) ?? []) {
        if (seen.has(imp)) { continue; }
        seen.add(imp);
        if (isTestFile(imp)) { found.add(imp); } else { queue.push(imp); }
      }
    }
    return [...found];
  }

  /**
   * For a given source file + test file, return the suites that have shared vars.
   * Used to decide whether to run just one test or the whole suite on rerun.
   */
  getSuiteInfo(sourceFilePath: string, testFilePath: string): { [suite: string]: SuiteTraceInfo } {
    return this._sourceToTests.get(sourceFilePath)?.[testFilePath] ?? {};
  }

  // ── Line → test reverse index ──────────────────────────────────────────────

  /**
   * Merge a per-file line→test mapping into the index.
   * Called by the batch runners after each trace parse; a rerun test file's
   * old entries were removed first (forgetTestFiles).
   */
  mergeLineToTests(
    sourceFilePath: string,
    testFileId: string,
    lineMap: Map<number, string[]>,  // line → array of fullName strings
  ): void {
    this._noteSource(testFileId, sourceFilePath);
    let fileMap = this._lineToTests.get(sourceFilePath);
    if (!fileMap) {
      fileMap = new Map();
      this._lineToTests.set(sourceFilePath, fileMap);
    }
    for (const [line, names] of lineMap) {
      let byFile = fileMap.get(line);
      if (!byFile) { byFile = new Map(); fileMap.set(line, byFile); }
      const existing = byFile.get(testFileId);
      if (!existing) { byFile.set(testFileId, [...new Set(names)]); continue; }
      const seen = new Set(existing);
      for (const fullName of names) {
        if (!seen.has(fullName)) { existing.push(fullName); seen.add(fullName); }
      }
    }
  }

  /**
   * Returns the tests that executed a given line in a source file.
   * Returns an empty array if no data exists (line not covered or not yet traced).
   */
  getTestsForLine(sourceFilePath: string, line: number): LineTestEntry[] {
    const byFile = this._lineToTests.get(sourceFilePath)?.get(line);
    if (!byFile) { return []; }
    const out: LineTestEntry[] = [];
    for (const [testFileId, names] of byFile) {
      for (const fullName of names) { out.push({ testFileId, fullName }); }
    }
    return out;
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

  // ── Replacing a test file's entries ────────────────────────────────────────

  /**
   * The test files ran again (whole): what they ran before no longer counts.
   * Called with every test file a batch finished, before its trace records
   * are applied — a test that was deleted or renamed, or no longer reaches a
   * line, leaves the index; a deleted test file is forgotten the same way.
   */
  forgetTestFiles(testFiles: Iterable<string>): void {
    for (const tf of testFiles) {
      const sources = this._sourcesOfTestFile.get(tf);
      if (!sources) { continue; }
      this._sourcesOfTestFile.delete(tf);
      for (const src of sources) {
        const mapping = this._sourceToTests.get(src);
        if (mapping && mapping[tf]) {
          delete mapping[tf];
          if (Object.keys(mapping).length === 0) { this._sourceToTests.delete(src); }
        }
        const lines = this._lineToTests.get(src);
        if (!lines) { continue; }
        for (const [line, byFile] of lines) {
          if (byFile.delete(tf) && byFile.size === 0) { lines.delete(line); }
        }
        if (lines.size === 0) { this._lineToTests.delete(src); }
      }
    }
  }

  /** Every test that ran any line of the source file (optionally only lines from..to, 1-based). */
  testsForFile(sourceFilePath: string, from = 1, to = Number.MAX_SAFE_INTEGER): LineTestEntry[] {
    const byLine = this._lineToTests.get(sourceFilePath);
    if (!byLine) { return []; }
    const seen = new Set<string>();
    const out: LineTestEntry[] = [];
    for (const [line, byFile] of byLine) {
      if (line < from || line > to) { continue; }
      for (const [testFileId, names] of byFile) {
        for (const fullName of names) {
          const key = `${testFileId}\0${fullName}`;
          if (!seen.has(key)) { seen.add(key); out.push({ testFileId, fullName }); }
        }
      }
    }
    return out;
  }

  /** The source lines one test ran, per source file (sorted, 1-based); empty when it was not traced. */
  linesRunBy(testFileId: string, fullName: string): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const src of this._sourcesOfTestFile.get(testFileId) ?? []) {
      const lines: number[] = [];
      for (const [line, byFile] of this._lineToTests.get(src) ?? []) {
        if (byFile.get(testFileId)?.includes(fullName)) { lines.push(line); }
      }
      if (lines.length > 0) { out.set(src, lines.sort((a, b) => a - b)); }
    }
    return out;
  }

  /** Test files whose entries are under `deleted` (a deleted test file or folder). */
  testFilesUnder(deleted: string, sep: string): string[] {
    const prefix = deleted.endsWith(sep) ? deleted : deleted + sep;
    return [...this._sourcesOfTestFile.keys()].filter((tf) => tf === deleted || tf.startsWith(prefix));
  }

  private _noteSource(testFile: string, sourceFile: string): void {
    let set = this._sourcesOfTestFile.get(testFile);
    if (!set) { set = new Set(); this._sourcesOfTestFile.set(testFile, set); }
    set.add(sourceFile);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Clear all data. Called when a new session starts (before starting the fresh run).
   * Trace files on disk are deleted by the batch runner / extension cleanup separately.
   */
  clearAll(): void {
    this._importers.clear();
    this._traceIndex.clear();
    this._coverageIndex.clear();
    this._sourceToTests.clear();
    this._lineToTests.clear();
    this._sourcesOfTestFile.clear();
  }
}
