import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver } from '../IResultObserver';
import { IFrameworkAdapter } from '../framework/IFrameworkAdapter';
import { DecorationManager } from '../editor/DecorationManager';
import { ResultsView } from '../views/ResultsView';
import { TestDiscoveryService } from './TestDiscoveryService';

/**
 * SessionManager — owns the test session lifecycle and all run execution.
 *
 * Responsibilities:
 *  - Start / stop a TestSession
 *  - Discover test files on startup
 *  - Run files (concurrency pool)
 *  - Handle on-save reruns
 *  - Handle scoped reruns (file / suite / test)
 *  - Maintain and update the status bar
 *
 * Everything framework-specific is delegated to the IFrameworkAdapter.
 * Everything UI-specific is delegated to the observer list.
 */
export class SessionManager {
  private _session: TestSession | undefined;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _adapter: IFrameworkAdapter,
    private readonly _store: ResultStore,
    private readonly _selection: SelectionState,
    private readonly _resultsView: ResultsView,
    private readonly _observers: IResultObserver[],
    private readonly _outputChannel: vscode.OutputChannel,
    private readonly _statusBar: vscode.StatusBarItem,
    private readonly _discovery: TestDiscoveryService,
  ) {}

  // ── Session lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      const pick = await vscode.window.showErrorMessage(
        'No project root found. Open a single folder or configure liveTestRunner.projectRoot.',
        'Select Project Root',
      );
      if (pick) { await this.selectProjectRoot(); }
      return;
    }

    if (this._session) {
      this._session.stop();
      this._session = undefined;
    }

    vscode.commands.executeCommand('liveTestRunner.results.focus');
    this._outputChannel.appendLine('');
    this._outputChannel.appendLine(`[Live Test Runner] Starting — ${projectRoot}`);

    // Bootstrap a session with a Jest runner to hold the coverage map
    const cfg             = vscode.workspace.getConfiguration('liveTestRunner');
    const cmd             = cfg.get<string>('runMode') === 'npm' ? 'npm test --' : (cfg.get<string>('jestCommand') || '');
    const bootstrapRunner = new JestRunner(cmd, (msg) => this._outputChannel.appendLine(msg));
    this._session         = new TestSession(bootstrapRunner);

    try {
      // ── Wait for background discovery to finish ────────────────────────────
      // Discovery runs on activate. If the user clicks Start Testing while it
      // is still in progress, we wait here rather than running with a partial store.
      if (this._discovery.isDiscovering) {
        this._updateStatusBar('Waiting for discovery…');
        await this._discovery.awaitDiscovery();
      }

      // ── Derive the file list from the already-populated store ──────────────
      const testFiles = this._store.getAllFiles().map((f) => f.filePath);
      this._outputChannel.appendLine(`[Live Test Runner] Starting run — ${testFiles.length} file(s)`);

      if (testFiles.length === 0) {
        this._updateStatusBar('✅ Ready');
        this._session.activate();
        return;
      }

      this._session.activate();
      this._notify('onSessionStarted');

      // Push the discovered (pending) tree to the UI so the run-started state
      // shows all tests before the first result arrives.
      this._notify('onRunStarted', {
        fileCount: testFiles.length,
        files: (this._store.toJSON() as { files: unknown[] }).files,
      });

      // ── Run the tests ──────────────────────────────────────────────────────
      await this._runFiles(testFiles, projectRoot, true);
    } catch (error) {
      this._updateStatusBar('❌ Error');
      vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
    }
  }

  stop(decorationManager: DecorationManager): void {
    if (this._session) {
      this._session.stop();
      this._session = undefined;
    }
    this._store.clearAllLineMaps();
    this._notify('onSessionStopped');
    void decorationManager; // already in observers, notified above
    this._updateStatusBar('Off');
  }

  isActive(): boolean {
    return !!this._session?.isTestingActive();
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async selectProjectRoot(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('No workspace folders are open.');
      return;
    }
    const selected = folders.length === 1
      ? folders[0].uri.fsPath
      : await vscode.window.showQuickPick(
          folders.map((f: vscode.WorkspaceFolder) => f.uri.fsPath),
          { placeHolder: 'Select project root' },
        );
    if (selected) {
      await vscode.workspace
        .getConfiguration('liveTestRunner')
        .update('projectRoot', selected, vscode.ConfigurationTarget.Workspace);
    }
  }

  async rerunScope(args: {
    scope: string;
    fileId: string;
    suiteId?: string;
    testId?: string;
    fullName?: string;
  }): Promise<void> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) { return; }

    if ((args.scope === 'test' || args.scope === 'suite') && args.fullName) {
      this._notify('onFilesRerunning', [args.fileId], args.suiteId, args.testId);
      this._updateStatusBar('Running… 1/1');
      try {
        await this._adapter.runTestCase(
          this._store,
          args.fileId,
          args.fullName,
          projectRoot,
          (msg) => this._outputChannel.appendLine(msg),
          { suiteId: args.suiteId, testId: args.testId },
        );
      } catch (error) {
        this._outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
      }
      this._notify('onFileResult', args.fileId);
      this._refreshScopedLogs(args.fileId);
      this._updateStatusBar('✅ Ready');
      return;
    }

    await this._runFiles([args.fileId], projectRoot);
  }

  // ── Editor commands ───────────────────────────────────────────────────────

  async debugFromEditor(filePath: string, testFullName?: string): Promise<void> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) { return; }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    const config = this._adapter.getDebugConfig(projectRoot, filePath, testFullName);
    await vscode.debug.startDebugging(folder, config);
  }

  // ── On-save handler ────────────────────────────────────────────────────────

  onSave(document: vscode.TextDocument): void {
    if (!this._session?.isTestingActive()) { return; }
    const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get<number>('onSaveDebounceMs') ?? 300;

    setTimeout(async () => {
      if (!this._session) { return; }
      try {
        const projectRoot = this._getProjectRoot();
        if (!projectRoot) { return; }

        let filesToRun: string[];
        if (this._adapter.isTestFile(document.uri.fsPath)) {
          filesToRun = [document.uri.fsPath];
        } else {
          const affected = this._adapter.getAffectedTests(this._session, document.uri.fsPath);
          if (affected.length === 0) { return; }
          filesToRun = affected;
        }
        await this._runFiles(filesToRun, projectRoot);
      } catch (error) {
        this._updateStatusBar('✅ Ready');
        this._outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
      }
    }, debounceMs);
  }

  // ── Workspace change handler ───────────────────────────────────────────────

  onWorkspaceFoldersChanged(): void {
    if (this._session) {
      this._session.stop();
      this._session = undefined;
      this._store.clear();
      this._updateStatusBar('Off');
      this._notify('onRunFinished', { total: 0, passed: 0, failed: 0, totalDuration: 0, sessionActive: false });
    }
  }

  // ── Private: run execution ─────────────────────────────────────────────────

  private async _runFiles(filePaths: string[], projectRoot: string, isFullSuite = false): Promise<void> {
    const CONCURRENCY = 3;
    const queue = [...filePaths];
    let completed = 0, numPassed = 0, numFailed = 0;

    for (const fp of filePaths) {
      this._store.fileStarted(fp, fp, vscode.workspace.asRelativePath(fp));
    }

    if (!isFullSuite) {
      this._notify('onFilesRerunning', filePaths);
    }
    this._updateStatusBar(`Running… 0/${filePaths.length}`);

    const totalStart = Date.now();
    const log = (msg: string) => this._outputChannel.appendLine(msg);

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, async () => {
        while (true) {
          const filePath = queue.shift();
          if (!filePath) { break; }

          try {
            const status = await this._adapter.runFile(this._store, filePath, projectRoot, log);
            if (status === 'passed') { numPassed++; } else { numFailed++; }
          } catch {
            this._store.fileResult(filePath, 'failed');
            numFailed++;
          }

          completed++;
          this._updateStatusBar(`Running… ${completed}/${filePaths.length}`);
          this._notify('onFileResult', filePath);
          this._refreshScopedLogs(filePath);
        }
      }),
    );

    this._outputChannel.appendLine(`[Live Test Runner] Finished in ${Date.now() - totalStart}ms`);

    const summary = this._store.getSummary();
    this._notify('onRunFinished', {
      total:         summary.total,
      passed:        summary.passed,
      failed:        summary.failed,
      totalDuration: summary.totalDuration,
      sessionActive: this.isActive(),
    });

    if (numFailed > 0)      { this._updateStatusBar(`❌ ${numFailed} failed, ${numPassed} passed`); }
    else if (numPassed > 0) { this._updateStatusBar(`✅ ${numPassed} passed`); }
  }

  // ── Private: helpers ───────────────────────────────────────────────────────

  private _notify<K extends keyof IResultObserver>(
    method: K,
    ...args: Parameters<IResultObserver[K] extends (...a: never[]) => unknown ? IResultObserver[K] : never>
  ): void {
    for (const obs of this._observers) {
      (obs[method] as (...a: unknown[]) => void)(...(args as unknown[]));
    }
  }

  private _refreshScopedLogs(fileId: string): void {
    const sel = this._selection.get();
    if (sel?.fileId === fileId) {
      this._resultsView.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
    }
  }

  private _getProjectRoot(): string | undefined {
    const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot');
    if (configured?.trim()) { return configured.trim(); }
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) { return folders[0].uri.fsPath; }
    return undefined;
  }

  private _updateStatusBar(text: string): void {
    this._statusBar.text = `Live Tests: ${text}`;
  }
}
