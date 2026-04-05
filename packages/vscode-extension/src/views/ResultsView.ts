import { OutputLine } from '../store/ResultStore';
import { BaseWebviewProvider } from './BaseWebviewProvider';
import { RunFinishedPayload } from '../IResultObserver';

// ── Scoped log payload types ───────────────────────────────────────────────────

export type LogSection = {
  label: string;
  scope: 'file' | 'suite' | 'test';
  capturedAt: number | null;
  lines: OutputLine[];
};

export type ErrorEntry = {
  testName: string;
  failureMessages: string[];
  capturedAt: number | null;
};

export type ErrorSection = {
  label: string;
  scope: 'file' | 'suite' | 'test';
  errors: ErrorEntry[];
};

export type ScopedLogPayload = {
  logSections: LogSection[];
  errorSections: ErrorSection[];
};

export class ResultsView extends BaseWebviewProvider {
  public static readonly viewId = 'liveTestRunner.results';

  protected get _htmlFile(): string { return 'results.html'; }

  // ── IResultObserver overrides ──────────────────────────────────────────────

  /** After broadcasting the file result, also refresh scoped logs if this file is selected. */
  onFileResult(filePath: string): void {
    super.onFileResult(filePath);
    const sel = this.selection.get();
    if (sel?.fileId === filePath) {
      this.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
    }
  }

  onRunFinished(payload: RunFinishedPayload): void {
    super.onRunFinished(payload);
  }

  // ── Results-view-specific ──────────────────────────────────────────────────

  sendScopedData(fileId: string, suiteId?: string, testId?: string): void {
    this._sendScopedLogs(fileId, suiteId, testId);
  }

  protected handleExtraMessage(msg: { type: string; fileId?: string; suiteId?: string; testId?: string }): void {
    if (msg.type === 'select' && msg.fileId) {
      this._sendScopedLogs(msg.fileId, msg.suiteId, msg.testId);
    }
  }

  protected _sendInit(): void {
    this.postMessage({
      type:  'init',
      files: (this.store.toJSON() as { files: unknown[] }).files,
    });
  }

  // ── Scoped log builders ────────────────────────────────────────────────────

  private _sendScopedLogs(fileId: string, suiteId?: string, testId?: string): void {
    const payload = this._buildScopedLogPayload(fileId, suiteId, testId);
    this.postMessage({ type: 'scope-logs', payload });
  }

  private _buildScopedLogPayload(fileId: string, suiteId?: string, testId?: string): ScopedLogPayload {
    if (testId && suiteId) { return this._buildTestPayload(fileId, suiteId, testId); }
    if (suiteId)           { return this._buildSuitePayload(fileId, suiteId); }
    return this._buildFilePayload(fileId);
  }

  private _buildFilePayload(fileId: string): ScopedLogPayload {
    const fileResult = this.store.getFile(fileId);
    if (!fileResult) { return { logSections: [], errorSections: [] }; }

    const fileOutput = this.store.getFileOutput(fileId);
    const logSections: LogSection[] = [{
      label: fileResult.filePath, scope: 'file',
      capturedAt: fileOutput.capturedAt, lines: fileOutput.lines,
    }];

    for (const [suiteId, suite] of fileResult.suites) {
      const suiteOutput = this.store.getSuiteOutput(fileId, suiteId);
      if (suiteOutput.capturedAt !== null && suiteOutput.lines.length > 0) {
        logSections.push({ label: suite.name, scope: 'suite', capturedAt: suiteOutput.capturedAt, lines: suiteOutput.lines });
      }
      for (const [testId, test] of suite.tests) {
        const testOutput = this.store.getTestOutput(fileId, suiteId, testId);
        if (testOutput.capturedAt !== null && testOutput.lines.length > 0) {
          logSections.push({ label: test.name, scope: 'test', capturedAt: testOutput.capturedAt, lines: testOutput.lines });
        }
      }
    }

    const fileErrors: ErrorEntry[] = [];
    for (const [suiteId, suite] of fileResult.suites) {
      for (const [testId, test] of suite.tests) {
        if (test.failureMessages.length > 0) {
          fileErrors.push({
            testName: test.name,
            failureMessages: test.failureMessages,
            capturedAt: this.store.getTestOutput(fileId, suiteId, testId).capturedAt ?? fileOutput.capturedAt,
          });
        }
      }
    }

    const errorSections: ErrorSection[] = fileErrors.length > 0
      ? [{ label: fileResult.filePath, scope: 'file', errors: fileErrors }]
      : [];

    return { logSections, errorSections };
  }

  private _buildSuitePayload(fileId: string, suiteId: string): ScopedLogPayload {
    const suite = this.store.getSuite(fileId, suiteId);
    if (!suite) { return { logSections: [], errorSections: [] }; }

    const suiteOutput = this.store.getSuiteOutput(fileId, suiteId);
    const logSections: LogSection[] = [{
      label: suite.name, scope: 'suite',
      capturedAt: suiteOutput.capturedAt, lines: suiteOutput.lines,
    }];

    for (const [testId, test] of suite.tests) {
      const testOutput = this.store.getTestOutput(fileId, suiteId, testId);
      if (testOutput.capturedAt !== null && testOutput.lines.length > 0) {
        logSections.push({ label: test.name, scope: 'test', capturedAt: testOutput.capturedAt, lines: testOutput.lines });
      }
    }

    const suiteErrors: ErrorEntry[] = [];
    for (const [testId, test] of suite.tests) {
      if (test.failureMessages.length > 0) {
        suiteErrors.push({
          testName: test.name,
          failureMessages: test.failureMessages,
          capturedAt: this.store.getTestOutput(fileId, suiteId, testId).capturedAt,
        });
      }
    }

    const errorSections: ErrorSection[] = suiteErrors.length > 0
      ? [{ label: suite.name, scope: 'suite', errors: suiteErrors }]
      : [];

    return { logSections, errorSections };
  }

  private _buildTestPayload(fileId: string, suiteId: string, testId: string): ScopedLogPayload {
    const test = this.store.getTest(fileId, suiteId, testId);
    if (!test) { return { logSections: [], errorSections: [] }; }

    const testOutput = this.store.getTestOutput(fileId, suiteId, testId);

    const logSections: LogSection[] = [{
      label: test.name, scope: 'test',
      capturedAt: testOutput.capturedAt, lines: testOutput.lines,
    }];

    const errorSections: ErrorSection[] = test.failureMessages.length > 0
      ? [{ label: test.name, scope: 'test', errors: [{ testName: test.name, failureMessages: test.failureMessages, capturedAt: testOutput.capturedAt }] }]
      : [];

    return { logSections, errorSections };
  }
}
