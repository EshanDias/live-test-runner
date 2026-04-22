import * as vscode from 'vscode';
import { ResultStore } from '../store/ResultStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { getThresholds, getCoverageThresholds } from '../utils/duration';

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

  private _pendingFileResults: string[] = [];
  private _resultFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
            nodeId: msg.nodeId,
          });
          break;
        case 'rerun':
          vscode.commands.executeCommand('liveTestRunner.rerunScope', {
            scope:    msg.scope,
            fileId:   msg.fileId,
            nodeId:   msg.nodeId,
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
          } else if (msg.command === 'stopAndClearCache') {
            vscode.commands.executeCommand('liveTestRunner.stopAndClearCache');
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

  onFilesRerunning(fileIds: string[], nodeId?: string): void {
    this.postMessage({ type: 'files-rerunning', fileIds, nodeId });
  }

  onFileResult(filePath: string): void {
    if (!this.store.getFile(filePath)) { return; }
    this._pendingFileResults.push(filePath);
    if (this._resultFlushTimer === null) {
      this._resultFlushTimer = setTimeout(() => this._flushFileResults(), 50);
    }
  }

  protected _flushFileResults(): void {
    this._resultFlushTimer = null;
    const paths = this._pendingFileResults.splice(0);
    if (paths.length === 0) { return; }
    const summary = this.store.getSummary();
    const files = paths.map((fp) => this.store.serialiseFile(fp)).filter(Boolean);
    if (files.length === 0) { return; }
    this.postMessage({ type: 'batch-file-results', files, total: summary.total, passed: summary.passed, failed: summary.failed });
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

  onDiscoveryProgress(files: unknown[], discovered: number, total: number): void {
    this._discoveryDone = discovered;
    const summary = this.store.getSummary();
    this.postMessage({ type: 'discovery-progress', files, discovered, fileTotal: total, total: summary.total, passed: summary.passed, failed: summary.failed });
  }

  onDiscoveryComplete(): void {
    this._isDiscovering = false;
    this.postMessage({ type: 'discovery-complete' });
  }

  onDiscoveryFileRemoved(fileId: string): void {
    this.postMessage({ type: 'discovery-file-removed', fileId });
  }

  onSourceScanProgress(scanned: number, total: number): void {
    this.postMessage({ type: 'source-scan-progress', scanned, total });
  }

  onSourceScanDone(): void {
    this.postMessage({ type: 'source-scan-done' });
  }

  onCoverageUpdated(totals: unknown, files: unknown[]): void {
    this.postMessage({ type: 'coverage-updated', totals, files });
  }

  dispose(): void {}

  // ── Public helpers ─────────────────────────────────────────────────────────

  get sessionActive(): boolean { return this._sessionActive; }

  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  // ── Subclass hooks ─────────────────────────────────────────────────────────

  public syncNow(): void { this._sendInit(); }

  protected abstract _sendInit(): void;
  protected abstract get _htmlFile(): string;

  /** Override to handle view-specific message types. */
  protected handleExtraMessage(_msg: unknown): void {}

  /** Returns current duration thresholds from VS Code settings for inclusion in init messages. */
  protected _getThresholds() {
    return getThresholds();
  }

  /** Returns current coverage thresholds from VS Code settings. */
  protected _getCoverageThresholds() {
    return getCoverageThresholds();
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
    const testListViewUri          = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'testListView.js'));
    const coverageExplorerViewUri  = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'coverageExplorerView.js'));
    const timelineSidebarUri       = webview.asWebviewUri(vscode.Uri.joinPath(viewsDir,      'timelineSidebar.js'));
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
      .replace(/\{\{testListViewUri\}\}/g,         testListViewUri.toString())
      .replace(/\{\{coverageExplorerViewUri\}\}/g, coverageExplorerViewUri.toString())
      .replace(/\{\{timelineSidebarUri\}\}/g,      timelineSidebarUri.toString())
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
