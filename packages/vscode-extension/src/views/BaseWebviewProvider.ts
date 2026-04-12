import * as vscode from 'vscode';
import { ResultStore } from '../store/ResultStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { getThresholds } from '../utils/duration';

/**
 * Shared base for ExplorerView and ResultsView.
 *
 * Handles: webview lifecycle, common message routing (open-file, rerun, select,
 * cmd), all IResultObserver methods, and postMessage.
 *
 * Subclasses supply:
 *  - _htmlFile        — filename inside src/webview/ to load
 *  - _sendInit()      — payload pushed on 'ready' and visibility restore
 *  - handleExtraMessage() — optional hook for view-specific message types
 */
export abstract class BaseWebviewProvider
  implements vscode.WebviewViewProvider, IResultObserver
{
  protected view?: vscode.WebviewView;
  protected _sessionActive  = false;
  protected _isDiscovering  = false;
  protected _discoveryTotal = 0;
  protected _discoveryDone  = 0;

  constructor(
    protected readonly extensionUri: vscode.Uri,
    protected readonly store: ResultStore,
    protected readonly selection: SelectionState,
  ) {}

  // ── WebviewViewProvider ────────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
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
      if (webviewView.visible) { this._sendInit(); }
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
            scope:    msg.scope,
            fileId:   msg.fileId,
            suiteId:  msg.suiteId,
            testId:   msg.testId,
            fullName: msg.fullName,
          });
          break;
        case 'open-file':
          if (msg.filePath) {
            const uri  = vscode.Uri.file(msg.filePath);
            const line = typeof msg.line === 'number' ? msg.line - 1 : 0;
            const pos  = new vscode.Position(line, 0);
            vscode.window.showTextDocument(uri, {
              selection:     new vscode.Range(pos, pos),
              preserveFocus: false,
            });
          }
          break;
        case 'cmd':
          if (msg.command === 'start') {
            vscode.commands.executeCommand('liveTestRunner.startTesting');
          } else if (msg.command === 'stop') {
            vscode.commands.executeCommand('liveTestRunner.stopTesting');
          }
          break;
        default:
          this.handleExtraMessage(msg);
          break;
      }
    });
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(): void {
    this._sessionActive = true;
    this.postMessage({ type: 'session-started' });
  }

  onSessionStopped(): void {
    this._sessionActive = false;
    this.postMessage({ type: 'session-stopped' });
  }

  onRunStarted(payload: RunStartedPayload): void {
    this.postMessage({ type: 'run-started', fileCount: payload.fileCount, files: payload.files });
  }

  onFilesRerunning(fileIds: string[], suiteId?: string, testId?: string): void {
    this.postMessage({ type: 'files-rerunning', fileIds, suiteId, testId });
  }

  onFileResult(filePath: string): void {
    const fileData = this.store.getFile(filePath);
    if (!fileData) { return; }
    const summary = this.store.getSummary();
    this.postMessage({
      type: 'full-file-result',
      file: {
        fileId:   fileData.fileId,
        filePath: fileData.filePath,
        name:     fileData.name,
        status:   fileData.status,
        duration: fileData.duration,
        suites: Array.from(fileData.suites.values()).map((s) => ({
          suiteId:  s.suiteId,
          name:     s.name,
          status:   s.status,
          duration: s.duration,
          line:     s.line,
          tests: Array.from(s.tests.values()).map((t) => ({
            testId:          t.testId,
            name:            t.name,
            fullName:        t.fullName,
            status:          t.status,
            duration:        t.duration,
            line:            t.line,
            failureMessages: t.failureMessages,
          })),
        })),
      },
      total:         summary.total,
      passed:        summary.passed,
      failed:        summary.failed,
      totalDuration: summary.totalDuration,
    });
  }

  onRunFinished(payload: RunFinishedPayload): void {
    this.postMessage({ type: 'run-finished', ...payload });
  }

  onTracingProgress(completed: number, total: number, done?: boolean): void {
    this.postMessage({ type: 'tracing-progress', completed, total, done: done ?? false });
  }

  onDiscoveryStarted(total: number): void {
    this._isDiscovering  = true;
    this._discoveryTotal = total;
    this._discoveryDone  = 0;
    this.postMessage({ type: 'discovery-started', total });
  }

  onDiscoveryProgress(file: unknown, discovered: number, total: number): void {
    this._discoveryDone = discovered;
    const summary = this.store.getSummary();
    this.postMessage({ type: 'discovery-progress', file, discovered, fileTotal: total, total: summary.total, passed: summary.passed, failed: summary.failed });
  }

  onDiscoveryComplete(): void {
    this._isDiscovering = false;
    this.postMessage({ type: 'discovery-complete' });
  }

  dispose(): void {}

  // ── Public helpers ─────────────────────────────────────────────────────────

  get sessionActive(): boolean { return this._sessionActive; }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  // ── Subclass hooks ─────────────────────────────────────────────────────────

  protected abstract _sendInit(): void;
  protected abstract get _htmlFile(): string;

  /** Override to handle view-specific message types. */
  protected handleExtraMessage(_msg: unknown): void {}

  /** Returns current duration thresholds from VS Code settings for inclusion in init messages. */
  protected _getThresholds() {
    return getThresholds();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _buildHtml(webview: vscode.Webview): string {
    const webviewDir        = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview');
    const viewsDir          = vscode.Uri.joinPath(webviewDir, 'views');
    const componentsDir     = vscode.Uri.joinPath(webviewDir, 'components');
    const timelineDir       = vscode.Uri.joinPath(webviewDir, 'timeline');

    const stylesUri              = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir,    'styles.css'));
    const utilsUri               = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir,    'utils.js'));
    const testListLayoutUri      = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir,    'testListLayout.js'));
    const routerUri              = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir,    'router.js'));
    const logPanelUri            = webview.asWebviewUri(vscode.Uri.joinPath(componentsDir, 'logPanel.js'));
    const errorPanelUri          = webview.asWebviewUri(vscode.Uri.joinPath(componentsDir, 'errorPanel.js'));
    const resultsViewUri         = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'resultsView.js'));
    const timelineViewUri        = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'timelineView.js'));
    const testListViewUri        = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'testListView.js'));
    const timelineSidebarUri     = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'timelineSidebar.js'));
    const playbackEngineUri      = webview.asWebviewUri(vscode.Uri.joinPath(timelineDir,   'PlaybackEngine.js'));

    const nonce     = getNonce();
    const cspSource = webview.cspSource;

    const html = require('fs').readFileSync(
      require('path').join(this.extensionUri.fsPath, 'src', 'webview', this._htmlFile),
      'utf8',
    ) as string;

    return html
      .replace(/\{\{cspSource\}\}/g,          cspSource)
      .replace(/\{\{nonce\}\}/g,              nonce)
      .replace(/\{\{stylesUri\}\}/g,          stylesUri.toString())
      .replace(/\{\{utilsUri\}\}/g,           utilsUri.toString())
      .replace(/\{\{testListLayoutUri\}\}/g,  testListLayoutUri.toString())
      .replace(/\{\{logPanelUri\}\}/g,        logPanelUri.toString())
      .replace(/\{\{errorPanelUri\}\}/g,      errorPanelUri.toString())
      .replace(/\{\{routerUri\}\}/g,          routerUri.toString())
      .replace(/\{\{resultsViewUri\}\}/g,     resultsViewUri.toString())
      .replace(/\{\{timelineViewUri\}\}/g,    timelineViewUri.toString())
      .replace(/\{\{testListViewUri\}\}/g,    testListViewUri.toString())
      .replace(/\{\{timelineSidebarUri\}\}/g, timelineSidebarUri.toString())
      .replace(/\{\{playbackEngineUri\}\}/g,  playbackEngineUri.toString());
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
