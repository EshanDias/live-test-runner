import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ResultStore } from './ResultStore';
import { SelectionState } from './SelectionState';

export class TestExplorerProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'liveTestRunner.explorer';

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

    // Register with SelectionState so it receives scope-changed broadcasts
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
          if (msg.command === 'start') vscode.commands.executeCommand('liveTestRunner.startTesting');
          else if (msg.command === 'stop') vscode.commands.executeCommand('liveTestRunner.stopTesting');
          break;
      }
    });
  }

  /** Call whenever the store changes to push the latest state to the webview. */
  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private _sendInit(): void {
    const summary = this.store.getSummary();
    this.view?.webview.postMessage({
      type: 'init',
      files: (this.store.toJSON() as { files: unknown[] }).files,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
    const testListLayoutUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'testListLayout.js'));
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    let html = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'src', 'webview', 'explorer.html'),
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
