import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ResultStore } from './ResultStore';
import { SelectionState } from './SelectionState';

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
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    this.selection.register(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.selection.unregister(webviewView.webview);
      this.view = undefined;
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
          this._sendScopedData(msg.fileId, msg.suiteId, msg.testId);
          break;
        case 'rerun':
          vscode.commands.executeCommand('liveTestRunner.rerunScope', {
            scope: msg.scope,
            fileId: msg.fileId,
            suiteId: msg.suiteId,
            testId: msg.testId,
          });
          break;
      }
    });
  }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Sends scoped output + failure data to the results panel.
   * Called both from 'select' messages and from SelectionState broadcasts
   * so columns 2 & 3 always reflect the active scope.
   */
  sendScopedData(fileId: string, suiteId?: string, testId?: string): void {
    this._sendScopedData(fileId, suiteId, testId);
  }

  private _sendScopedData(fileId: string, suiteId?: string, testId?: string): void {
    const outputLines = this.store.getOutputLines(fileId, suiteId, testId);
    const failureMessages = this.store.getFailureMessages(fileId, suiteId, testId);
    this.view?.webview.postMessage({
      type: 'scope-changed',
      fileId,
      suiteId,
      testId,
      outputLines,
      failureMessages,
    });
  }

  private _sendInit(): void {
    this.view?.webview.postMessage({
      type: 'init',
      files: (this.store.toJSON() as { files: unknown[] }).files,
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
    const testListLayoutUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'testListLayout.js'));
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'src', 'webview', 'results.html'),
      'utf8'
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
