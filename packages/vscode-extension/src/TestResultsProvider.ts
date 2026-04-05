import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ResultStore, OutputLine } from './ResultStore';
import { SelectionState } from './SelectionState';

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

export class TestResultsProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'liveTestRunner.results';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ResultStore,
    private readonly selection: SelectionState,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'src', 'webview'),
      ],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    this.selection.register(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.selection.unregister(webviewView.webview);
      this.view = undefined;
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this._sendInit();
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case 'ready':
          this._sendInit();
          break;
        case 'select':
          this.selection.select({
            scope: msg.scope,
            fileId: msg.fileId,
            suiteId: msg.suiteId,
            testId: msg.testId,
          });
          // Send scoped logs + errors back to this webview
          this._sendScopedLogs(msg.fileId, msg.suiteId, msg.testId);
          break;
        case 'rerun':
          vscode.commands.executeCommand('liveTestRunner.rerunScope', {
            scope: msg.scope,
            fileId: msg.fileId,
            suiteId: msg.suiteId,
            testId: msg.testId,
            fullName: msg.fullName,
          });
          break;
        case 'open-file':
          if (msg.filePath) {
            vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
          }
          break;
        case 'cmd':
          if (msg.command === 'start')
            vscode.commands.executeCommand('liveTestRunner.startTesting');
          else if (msg.command === 'stop')
            vscode.commands.executeCommand('liveTestRunner.stopTesting');
          break;
      }
    });
  }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Sends scoped output + failure data (as scope-logs) to the results panel.
   * Called when selection changes or a file run completes with an active selection.
   */
  sendScopedData(fileId: string, suiteId?: string, testId?: string): void {
    this._sendScopedLogs(fileId, suiteId, testId);
  }

  private _sendScopedLogs(
    fileId: string,
    suiteId?: string,
    testId?: string,
  ): void {
    const payload = this._buildScopedLogPayload(fileId, suiteId, testId);
    this.view?.webview.postMessage({ type: 'scope-logs', payload });
  }

  private _buildScopedLogPayload(
    fileId: string,
    suiteId?: string,
    testId?: string,
  ): ScopedLogPayload {
    if (testId && suiteId) {
      return this._buildTestPayload(fileId, suiteId, testId);
    }
    if (suiteId) {
      return this._buildSuitePayload(fileId, suiteId);
    }
    return this._buildFilePayload(fileId);
  }

  private _buildFilePayload(fileId: string): ScopedLogPayload {
    const fileResult = this.store.getFile(fileId);
    if (!fileResult) return { logSections: [], errorSections: [] };

    const fileOutput = this.store.getFileOutput(fileId);
    const logSections: LogSection[] = [];

    // File section — always included
    logSections.push({
      label: fileResult.filePath,
      scope: 'file',
      capturedAt: fileOutput.capturedAt,
      lines: fileOutput.lines,
    });

    // Suite/test sections — only if individually run (capturedAt set) and have lines
    for (const [suiteId, suite] of fileResult.suites) {
      const suiteOutput = this.store.getSuiteOutput(fileId, suiteId);
      if (suiteOutput.capturedAt !== null && suiteOutput.lines.length > 0) {
        logSections.push({
          label: suite.name,
          scope: 'suite',
          capturedAt: suiteOutput.capturedAt,
          lines: suiteOutput.lines,
        });
      }
      for (const [testId, test] of suite.tests) {
        const testOutput = this.store.getTestOutput(fileId, suiteId, testId);
        if (testOutput.capturedAt !== null && testOutput.lines.length > 0) {
          logSections.push({
            label: test.name,
            scope: 'test',
            capturedAt: testOutput.capturedAt,
            lines: testOutput.lines,
          });
        }
      }
    }

    // Error sections — all failures in the file
    const fileErrors: ErrorEntry[] = [];
    for (const [suiteId, suite] of fileResult.suites) {
      for (const [testId, test] of suite.tests) {
        if (test.failureMessages.length > 0) {
          fileErrors.push({
            testName: test.name,
            failureMessages: test.failureMessages,
            capturedAt:
              this.store.getTestOutput(fileId, suiteId, testId).capturedAt ??
              fileOutput.capturedAt,
          });
        }
      }
    }

    const errorSections: ErrorSection[] =
      fileErrors.length > 0
        ? [{ label: fileResult.filePath, scope: 'file', errors: fileErrors }]
        : [];

    return { logSections, errorSections };
  }

  private _buildSuitePayload(fileId: string, suiteId: string): ScopedLogPayload {
    const suite = this.store.getSuite(fileId, suiteId);
    if (!suite) return { logSections: [], errorSections: [] };

    const suiteOutput = this.store.getSuiteOutput(fileId, suiteId);
    const logSections: LogSection[] = [];

    // Suite section — always included (user explicitly selected it)
    logSections.push({
      label: suite.name,
      scope: 'suite',
      capturedAt: suiteOutput.capturedAt,
      lines: suiteOutput.lines,
    });

    // Test sections within this suite — only if individually run
    for (const [testId, test] of suite.tests) {
      const testOutput = this.store.getTestOutput(fileId, suiteId, testId);
      if (testOutput.capturedAt !== null && testOutput.lines.length > 0) {
        logSections.push({
          label: test.name,
          scope: 'test',
          capturedAt: testOutput.capturedAt,
          lines: testOutput.lines,
        });
      }
    }

    // Error sections — all failures in this suite
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

    const errorSections: ErrorSection[] =
      suiteErrors.length > 0
        ? [{ label: suite.name, scope: 'suite', errors: suiteErrors }]
        : [];

    return { logSections, errorSections };
  }

  private _buildTestPayload(
    fileId: string,
    suiteId: string,
    testId: string,
  ): ScopedLogPayload {
    const test = this.store.getTest(fileId, suiteId, testId);
    if (!test) return { logSections: [], errorSections: [] };

    const testOutput = this.store.getTestOutput(fileId, suiteId, testId);

    // Log section — always included (even if empty; user explicitly selected this test)
    const logSections: LogSection[] = [
      {
        label: test.name,
        scope: 'test',
        capturedAt: testOutput.capturedAt,
        lines: testOutput.lines,
      },
    ];

    // Error section — only if failed
    const errorSections: ErrorSection[] =
      test.failureMessages.length > 0
        ? [
            {
              label: test.name,
              scope: 'test',
              errors: [
                {
                  testName: test.name,
                  failureMessages: test.failureMessages,
                  capturedAt: testOutput.capturedAt,
                },
              ],
            },
          ]
        : [];

    return { logSections, errorSections };
  }

  private _sendInit(): void {
    this.view?.webview.postMessage({
      type: 'init',
      files: (this.store.toJSON() as { files: unknown[] }).files,
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'styles.css'),
    );
    const testListLayoutUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'testListLayout.js'),
    );
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'src', 'webview', 'results.html'),
      'utf8',
    );

    return html
      .replace(/\{\{cspSource\}\}/g, cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
      .replace(/\{\{testListLayoutUri\}\}/g, testListLayoutUri.toString());
  }
}

function getNonce(): string {
  let text = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
