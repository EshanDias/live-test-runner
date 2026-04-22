/**
 * extension.ts — activation entry point.
 *
 * This file is intentionally thin. Its only job is to:
 *  1. Create all service/provider instances
 *  2. Register VS Code commands and event subscriptions
 *  3. Hand control to SessionManager for all run logic
 *
 * No test-running logic, no Jest imports, no status bar text — those live in
 * SessionManager and JestAdapter respectively.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LTR_BASE_TMP_DIR } from './constants';
import { ResultStore } from './store/ResultStore';
import { ExecutionTraceStore } from './store/ExecutionTraceStore';
import { SelectionState } from './store/SelectionState';
import { JestAdapter } from './framework/JestAdapter';
import { CodeLensProvider } from './editor/CodeLensProvider';
import { DecorationManager } from './editor/DecorationManager';
import { ExplorerView } from './views/ExplorerView';
import { ResultsView } from './views/ResultsView';
import { SessionManager } from './session/SessionManager';
import { TestDiscoveryService } from './session/TestDiscoveryService';
import { IResultObserver } from './IResultObserver';
import { IInstrumentedRunner } from './timeline/IInstrumentedRunner';
import { JestInstrumentedRunner } from './timeline/JestInstrumentedRunner';
import { TimelineDecorationManager } from './timeline/TimelineDecorationManager';
import { DiscoveryCache, rotateAndCheckCapacity } from './cache/DiscoveryCache';
import { CoverageStore } from './coverage/CoverageStore';
import { CoverageDecorationManager } from './editor/CoverageDecorationManager';
import { CoverageHoverProvider } from './editor/CoverageHoverProvider';
import { logger } from './utils/logger';

const FILE = 'extension.ts';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Alive but no permission to signal
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Ensure the shared base temp directory exists.
  try {
    fs.mkdirSync(LTR_BASE_TMP_DIR, { recursive: true });
  } catch (err) {
    logger.error(FILE, 'activate', `Failed to create base temp directory: ${LTR_BASE_TMP_DIR}`, err);
  }

  // Clean up stale session directories from previous or crashed windows.
  try {
    for (const entry of fs.readdirSync(LTR_BASE_TMP_DIR)) {
      const fullPath = path.join(LTR_BASE_TMP_DIR, entry);

      // Handle new-style session directories: session-<pid>-<timestamp>
      const sessionMatch = entry.match(/^session-(\d+)-/);
      if (sessionMatch) {
        const pid = parseInt(sessionMatch[1], 10);
        if (!isProcessAlive(pid)) {
          logger.debug(FILE, 'activate', `Cleaning stale session dir: ${fullPath} (PID ${pid} not alive)`);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
        continue;
      }

      // Handle legacy trace directories (blindly clean up to migrate)
      if (entry.startsWith('traces-')) {
        logger.debug(FILE, 'activate', `Removing legacy trace dir: ${fullPath}`);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
  } catch (err) {
    logger.warn(FILE, 'activate', 'Error during stale session cleanup — continuing', err);
  }

  // Create a unique isolated directory for THIS session.
  const sessionDirName = `session-${process.pid}-${Date.now()}`;
  const LTR_SESSION_TMP_DIR = path.join(LTR_BASE_TMP_DIR, sessionDirName);
  try {
    fs.mkdirSync(LTR_SESSION_TMP_DIR, { recursive: true });
    logger.info(FILE, 'activate', `Session temp dir: ${LTR_SESSION_TMP_DIR}`);
  } catch (err) {
    logger.error(FILE, 'activate', `Failed to create session temp directory: ${LTR_SESSION_TMP_DIR}`, err);
  }


  // ── Infrastructure ─────────────────────────────────────────────────────────
  const outputChannel  = vscode.window.createOutputChannel('Live Test Runner', 'ansi');
  logger.init(outputChannel);
  logger.info(FILE, 'activate', `Extension activating — PID ${process.pid}`);
  const statusBar      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command    = 'liveTestRunner.showPanels';
  statusBar.text       = 'Live Tests: Off';
  statusBar.show();

  // ── State ──────────────────────────────────────────────────────────────────
  const store         = new ResultStore();
  const selection     = new SelectionState();
  const coverageStore = new CoverageStore();

  // ── Views and editor providers ─────────────────────────────────────────────
  const explorerView      = new ExplorerView(context.extensionUri, store, selection, coverageStore);
  const resultsView       = new ResultsView(context.extensionUri, store, selection);
  const decorationManager = new DecorationManager(store, context);
  const codeLensProvider  = new CodeLensProvider(store);
  const observers: IResultObserver[] = [explorerView, resultsView, decorationManager];

  // Register CodeLens immediately so ▶ Run / ▷ Debug appear as soon as
  // discovery populates the line map — no need to click Start Testing first.
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: '**/*.{test,spec}.{js,ts,jsx,tsx}' },
      codeLensProvider,
    ),
  );

  // When selection changes, push scoped logs to the results view
  const origSelect = selection.select.bind(selection);
  selection.select = (sel) => {
    origSelect(sel);
    resultsView.sendScopedData(sel.fileId, sel.nodeId);
  };

  // ── Timeline debugger ──────────────────────────────────────────────────────
  // Reference typed as the interface — never as the concrete class.
  const instrumentedRunner: IInstrumentedRunner = new JestInstrumentedRunner(LTR_SESSION_TMP_DIR);
  const timelineDecorations = new TimelineDecorationManager();

  // Last timeline run context, used by the Re-run button in the sidebar.
  let lastTimelineOptions: { filePath: string; testFullName: string } | null = null;

  // Last serialised store — kept so TimelineDecorationManager can render inline values.
  let lastTimelineStore: { steps: unknown[]; variables: Record<number, unknown[]> } | null = null;

  const routeExplorerToMain = () => {
    const summary = store.getSummary();
    explorerView.postMessage({
      type: 'route',
      view: 'testList',
      payload: {
        files: (store.toJSON() as { files: unknown[] }).files,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        sessionActive: explorerView.sessionActive,
      },
    });
  };

  // Forward step-changed from ResultsView to ExplorerView (sidebar state update)
  // and apply the editor highlight with inline variable values.
  resultsView.onStepChanged = (stepId, filePath, line) => {
    explorerView.postMessage({ type: 'step-update', stepId });
    if (lastTimelineStore) {
      timelineDecorations.applyStep(
        filePath,
        line,
        lastTimelineStore as Parameters<typeof timelineDecorations.applyStep>[2],
        stepId,
      ).catch((err) => {
        logger.error(FILE, 'onStepChanged', `applyStep failed for ${filePath}:${line} stepId=${stepId}`, err);
      });
    } else {
      timelineDecorations.highlight(filePath, line).catch((err) => {
        logger.error(FILE, 'onStepChanged', `highlight failed for ${filePath}:${line}`, err);
      });
    }
  };

  // Wire Add-to-Watch from hover → ExplorerView sidebar.
  timelineDecorations.onAddToWatch = (varName) => {
    explorerView.postMessage({ type: 'add-to-watch', varName });
  };

  // Clear decorations when the user navigates away from timeline mode.
  resultsView.onTimelineExit = () => {
    timelineDecorations.clearAll();
    routeExplorerToMain();
  };
  resultsView.onTimelineExitRequest = () => {
    resultsView.postMessage({
      type: 'route',
      view: 'results',
      payload: {
        files: (store.toJSON() as { files: unknown[] }).files,
      },
    });
    routeExplorerToMain();
  };
  explorerView.onTimelineExitRequest = () => {
    timelineDecorations.clearAll();
    resultsView.postMessage({
      type: 'route',
      view: 'results',
      payload: {
        files: (store.toJSON() as { files: unknown[] }).files,
      },
    });
    routeExplorerToMain();
  };

  // Re-run button in the sidebar.
  explorerView.onTimelineRerun = () => {
    if (!lastTimelineOptions) { return; }
    openTimelineDebugger(
      lastTimelineOptions.filePath,
      lastTimelineOptions.testFullName,
      instrumentedRunner,
      resultsView,
      explorerView,
      outputChannel,
      lastTimelineOptions,
      (s) => { lastTimelineStore = s; },
    );
  };

  // ── Coverage decoration manager ───────────────────────────────────────────
  const coverageDecoMgr = new CoverageDecorationManager(coverageStore);
  observers.push(coverageDecoMgr);
  context.subscriptions.push(coverageStore, coverageDecoMgr);

  // Propagate coverage updates to all observers (badge in Explorer view)
  context.subscriptions.push(
    coverageStore.onDidChange.event(() => {
      const totals = coverageStore.getTotals();
      const files  = coverageStore.getFileRows();
      observers.forEach((o) => o.onCoverageUpdated?.(totals, files));
    }),
  );

  // ── Execution trace store + trace directory ────────────────────────────────
  const traceStore = new ExecutionTraceStore();
  const traceDir   = path.join(LTR_SESSION_TMP_DIR, 'traces');

  function cleanTraceDir() {
    try { fs.rmSync(traceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    traceStore.clearAll();
  }

  // ── Discovery cache ────────────────────────────────────────────────────────
  const activationRoot = _resolveProjectRoot();
  let discoveryCache: DiscoveryCache | undefined;
  if (activationRoot) {
    discoveryCache = new DiscoveryCache(context.globalStorageUri.fsPath, activationRoot);
    discoveryCache.writeLock();
  }

  // ── Session manager ────────────────────────────────────────────────────────
  const discovery = new TestDiscoveryService();

  // Kick off static discovery immediately on activate so tests appear in the
  // sidebar before the user clicks Start Testing.
  if (activationRoot) {
    logger.info(FILE, 'activate', `Starting test discovery in: ${activationRoot}`);
    discovery.start(activationRoot, store, (msg) => outputChannel.appendLine(msg), {
      onFilesFound: (total) => {
        observers.forEach((o) => o.onDiscoveryStarted?.(total));
      },
      onBatchDiscovered: (files, discovered, total) => {
        observers.forEach((o) => o.onDiscoveryProgress?.(files, discovered, total));
      },
      onComplete: () => {
        observers.forEach((o) => o.onDiscoveryComplete?.());
      },
      onFileRemoved: (fileId) => {
        observers.forEach((o) => o.onDiscoveryFileRemoved?.(fileId));
      },
    }, discoveryCache);
  }

  const session = new SessionManager(
    new JestAdapter(LTR_SESSION_TMP_DIR),
    store,
    traceStore,
    coverageStore,
    selection,
    resultsView,
    observers,
    outputChannel,
    statusBar,
    discovery,
    LTR_SESSION_TMP_DIR,
  );

  // Expose cleanup so deactivate() can delete trace files on extension shutdown
  _cleanTraceDir = cleanTraceDir;
  _releaseDiscoveryLock = () => discoveryCache?.releaseLock();

  // ── Coverage hover provider ────────────────────────────────────────────────
  const coverageHoverProvider = new CoverageHoverProvider(traceStore, store, coverageStore);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file', pattern: '**/*.{ts,js,tsx,jsx}' },
      coverageHoverProvider,
    ),
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerView.viewId, explorerView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, resultsView, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('liveTestRunner.startTesting', async () => {
      // Check cache capacity before starting — evict stale projects or warn.
      if (activationRoot) {
        const cap = rotateAndCheckCapacity(context.globalStorageUri.fsPath);
        if (!cap.ok) {
          const choice = await vscode.window.showWarningMessage(
            `Live Test Runner cache is using ${cap.totalMb} MB across ${cap.activeCount} active sessions (limit: 500 MB). ` +
            `No inactive projects can be evicted right now. Close unused VS Code windows to free space, or continue without caching this session.`,
            'Continue Without Cache',
            'Cancel',
          );
          if (choice !== 'Continue Without Cache') { return; }
          // Run without cache this session
          discoveryCache?.releaseLock();
          discoveryCache = undefined;
        }
      }
      cleanTraceDir();
      return session.start();
    }),
    vscode.commands.registerCommand('liveTestRunner.stopTesting',        () => session.stop(decorationManager)),
    vscode.commands.registerCommand('liveTestRunner.stopAndClearCache',  async () => {
      session.stop(decorationManager);
      store.clearAll();
      cleanTraceDir();
      // Yield so session-stopped is processed by the webview before we send init
      await new Promise<void>((r) => setTimeout(r, 0));
      resultsView.syncNow();
      explorerView.syncNow();
      if (discoveryCache) {
        discoveryCache.releaseLock();
        discoveryCache.clear();
        discoveryCache.writeLock();
        logger.info(FILE, 'stopAndClearCache', 'Cache cleared for current project');
      }
    }),
    vscode.commands.registerCommand('liveTestRunner.clearCacheAndRestart', async () => {
      session.stop(decorationManager);
      if (discoveryCache && activationRoot) {
        discoveryCache.releaseLock();
        discoveryCache.clear();
        discoveryCache.writeLock();
        store.clearAll();
        cleanTraceDir();
        logger.info(FILE, 'clearCacheAndRestart', 'Cache cleared — restarting discovery');
        discovery.start(activationRoot, store, (msg) => outputChannel.appendLine(msg), {
          onFilesFound: (total) => { observers.forEach((o) => o.onDiscoveryStarted?.(total)); },
          onBatchDiscovered: (files, discovered, total) => { observers.forEach((o) => o.onDiscoveryProgress?.(files, discovered, total)); },
          onComplete: () => { observers.forEach((o) => o.onDiscoveryComplete?.());  },
          onFileRemoved: (fileId) => { observers.forEach((o) => o.onDiscoveryFileRemoved?.(fileId)); },
        }, discoveryCache);
        vscode.window.showInformationMessage('Live Test Runner: Cache cleared. Click Start Testing to run.');
      }
    }),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot',  () => session.selectProjectRoot()),
    vscode.commands.registerCommand('liveTestRunner.showOutput',         () => outputChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.showPanels',         () => {
      vscode.commands.executeCommand('liveTestRunner.explorer.focus');
      vscode.commands.executeCommand('liveTestRunner.results.focus');
    }),
    vscode.commands.registerCommand('liveTestRunner.rerunScope',         (args) => session.rerunScope(args)),
    vscode.commands.registerCommand('liveTestRunner.rerunFromEditor',    (filePath, line) => rerunFromEditor(filePath, line, store, session)),
    vscode.commands.registerCommand('liveTestRunner.debugFromEditor',    (filePath, line) => debugFromEditor(filePath, line, store, session)),
    vscode.commands.registerCommand('liveTestRunner.focusResult',        (fileId, nodeId) => focusResult(fileId, nodeId, store, selection, resultsView)),
    vscode.commands.registerCommand('liveTestRunner.revealTestInPanel',  (args: { testFileId: string; fullName: string }) => {
      const node = store.findNodeByFullName(args.testFileId, args.fullName);
      if (node) { focusResult(node.fileId, node.id, store, selection, resultsView); }
    }),
    vscode.commands.registerCommand('liveTestRunner.openTestFile',       async (args: { testFileId: string; fullName: string }) => {
      const node = store.findNodeByFullName(args.testFileId, args.fullName);
      const targetLine = node?.line != null ? node.line - 1 : 0; // VS Code range is 0-based
      const uri = vscode.Uri.file(args.testFileId);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(targetLine, 0, targetLine, 0),
        preserveFocus: false,
      });
    }),
    vscode.commands.registerCommand('liveTestRunner.showCoveringTests',   async (args: { filePath: string; line: number }) => {
      const tests = traceStore.getTestsForLine(args.filePath, args.line);
      if (tests.length === 0) { return; }

      const goToFileBtn: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('go-to-file'),
        tooltip: 'Open test file',
      };

      type Item = vscode.QuickPickItem & { testFileId: string; fullName: string };
      const items: Item[] = tests.map(({ testFileId, fullName }) => {
        const node   = store.findNodeByFullName(testFileId, fullName);
        const status = node?.status ?? 'pending';
        const icon   = status === 'passed' ? '$(testing-passed-icon)' : status === 'failed' ? '$(testing-failed-icon)' : '$(testing-queued-icon)';
        const detail = testFileId.replace(/\\/g, '/').split('/').pop() ?? testFileId;
        return { label: `${icon} ${fullName}`, detail, buttons: [goToFileBtn], testFileId, fullName };
      });

      const qp = vscode.window.createQuickPick<Item>();
      qp.title        = `Tests covering line ${args.line} (${tests.length})`;
      qp.placeholder  = 'Select a test to reveal in the panel';
      qp.matchOnDetail = true;
      qp.items        = items;

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        if (picked) {
          const node = store.findNodeByFullName(picked.testFileId, picked.fullName);
          if (node) { focusResult(node.fileId, node.id, store, selection, resultsView); }
        }
        qp.dispose();
      });

      qp.onDidTriggerItemButton(async ({ item }) => {
        const node       = store.findNodeByFullName(item.testFileId, item.fullName);
        const targetLine = node?.line != null ? node.line - 1 : 0;
        const uri        = vscode.Uri.file(item.testFileId);
        const doc        = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          selection:     new vscode.Range(targetLine, 0, targetLine, 0),
          preserveFocus: false,
        });
        qp.dispose();
      });

      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
    vscode.commands.registerCommand('liveTestRunner.openTimelineDebugger', (filePath: string, testFullName: string) => {
      lastTimelineOptions = { filePath, testFullName };
      return openTimelineDebugger(filePath, testFullName, instrumentedRunner, resultsView, explorerView, outputChannel, lastTimelineOptions,
        (s) => { lastTimelineStore = s; });
    }),

    // Timeline hover actions
    vscode.commands.registerCommand('liveTestRunner.addToWatch', (varName: string) => {
      explorerView.postMessage({ type: 'add-to-watch', varName });
    }),
    vscode.commands.registerCommand('liveTestRunner.copyValue', (value: string) => {
      void vscode.env.clipboard.writeText(value);
    }),
    vscode.commands.registerCommand('liveTestRunner.dumpTraceStore', () => {
      outputChannel.appendLine(traceStore.dump());
      outputChannel.show();
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) { codeLensProvider.refresh(); }
    }),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        decorationManager.applyToEditor(editor);
      }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => session.onSave(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.onWorkspaceFoldersChanged()),

    outputChannel,
    statusBar,
    { dispose: () => timelineDecorations.dispose() },
  );
}

let _cleanTraceDir: (() => void) | undefined;
let _releaseDiscoveryLock: (() => void) | undefined;

export function deactivate() {
  _cleanTraceDir?.();
  _releaseDiscoveryLock?.();
}

// ── Editor commands ───────────────────────────────────────────────────────────
// These live here (not in SessionManager) because they need both the store
// and the session — thin glue that reads store state then delegates to session.

async function rerunFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<void> {
  logger.debug(FILE, 'rerunFromEditor', `Rerun requested — file="${filePath}" line=${line}`);
  try {
    const entry = store.getLineMap(filePath).get(line);
    if (entry) {
      const node = store.getNode(entry.nodeId);
      if (node) {
        logger.debug(FILE, 'rerunFromEditor', `Rerunning node type="${node.type}" fullName="${node.fullName}"`);
        session.rerunScope({ scope: node.type, fileId: entry.fileId, nodeId: entry.nodeId, fullName: node.fullName });
        return;
      }
    }
    // describe blocks might not be in the LineMap at this exact line.
    // Try to extract the suite title from the source line and find the matching node.
    const nodeId = await _resolveNodeAtLine(filePath, line, store);
    if (nodeId) {
      const node = store.getNode(nodeId);
      logger.debug(FILE, 'rerunFromEditor', `Rerunning resolved suite nodeId="${nodeId}" fullName="${node?.fullName}"`);
      session.rerunScope({ scope: 'suite', fileId: filePath, nodeId, fullName: node?.fullName });
      return;
    }
    logger.debug(FILE, 'rerunFromEditor', `No node found at line ${line} — rerunning full file`);
    session.rerunScope({ scope: 'file', fileId: filePath });
  } catch (err) {
    logger.error(FILE, 'rerunFromEditor', `Unhandled error for "${filePath}:${line}"`, err);
  }
}

async function debugFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<void> {
  logger.debug(FILE, 'debugFromEditor', `Debug requested — file="${filePath}" line=${line}`);
  try {
    const entry = store.getLineMap(filePath).get(line);
    if (entry) {
      const node = store.getNode(entry.nodeId);
      logger.debug(FILE, 'debugFromEditor', `Debugging node fullName="${node?.fullName}"`);
      await session.debugFromEditor(filePath, node?.fullName);
      return;
    }
    // describe block — use node fullName as testNamePattern so Jest runs all tests within it
    const nodeId = await _resolveNodeAtLine(filePath, line, store);
    const fullName = nodeId ? store.getNode(nodeId)?.fullName : undefined;
    logger.debug(FILE, 'debugFromEditor', `Debugging resolved suite fullName="${fullName ?? '(whole file)'}"`);
    await session.debugFromEditor(filePath, fullName);
  } catch (err) {
    logger.error(FILE, 'debugFromEditor', `Unhandled error for "${filePath}:${line}"`, err);
  }
}

/** Extracts the describe title from a source line and looks it up in the store's node pool. */
async function _resolveNodeAtLine(
  filePath: string,
  line: number,
  store: ResultStore,
): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const lineText = doc.lineAt(line - 1).text;
    const m = lineText.match(/describe\s*[\.(]\s*['"`]([^'"`]+)['"`]/);
    if (!m) { return undefined; }
    // Search all nodes in this file for one matching the describe name
    const allNodes = store.getFileNodes(filePath);
    const match = allNodes.find(n => n.type === 'suite' && n.name === m[1]);
    return match?.id;
  } catch (err) {
    logger.warn(FILE, '_resolveNodeAtLine', `Could not resolve node at ${filePath}:${line}`, err);
    return undefined;
  }
}

async function openTimelineDebugger(
  filePath: string,
  testFullName: string,
  runner: IInstrumentedRunner,
  resultsView: ResultsView,
  explorerView: ExplorerView,
  outputChannel: vscode.OutputChannel,
  _optionsRef?: { filePath: string; testFullName: string },
  onStoreReady?: (store: { steps: unknown[]; variables: Record<number, unknown[]> }) => void,
): Promise<void> {
  const projectRoot = _resolveProjectRoot();
  if (!projectRoot) {
    vscode.window.showErrorMessage(
      'Live Test Runner: Cannot open Timeline Debugger — no project root configured.',
    );
    return;
  }

  // Route both panels to their timeline views and show a loading state.
  resultsView.postMessage({ type: 'route', view: 'timeline', payload: { testFullName, filePath } });
  explorerView.postMessage({ type: 'route', view: 'timelineSidebar', payload: { testFullName } });
  resultsView.postMessage({ type: 'timeline-loading' });

  outputChannel.appendLine(`[Timeline] Running instrumented trace: ${testFullName}`);
  logger.info(FILE, 'openTimelineDebugger', `Starting timeline trace — testFullName="${testFullName}" file="${filePath}"`);

  try {
    const store = await runner.run({ filePath, testFullName, projectRoot });

    // Convert Maps to plain objects for postMessage serialisation (Maps are not
    // JSON-serialisable and webviews receive messages via JSON.stringify).
    const serialisableStore = {
      ...store,
      variables: Object.fromEntries(store.variables),
      logs:      Object.fromEntries(store.logs),
    };

    outputChannel.appendLine(`[Timeline] Trace complete — ${store.steps.length} steps captured.`);
    logger.info(FILE, 'openTimelineDebugger', `Timeline trace complete — ${store.steps.length} steps captured`);
    onStoreReady?.(serialisableStore as { steps: unknown[]; variables: Record<number, unknown[]> });
    resultsView.postMessage({ type: 'timeline-ready', store: serialisableStore });
    explorerView.postMessage({ type: 'timeline-ready', store: serialisableStore });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[Timeline] Error: ${message}`);
    logger.error(FILE, 'openTimelineDebugger', `Timeline trace failed — testFullName="${testFullName}"`, err);
    vscode.window.showErrorMessage(`Timeline Debugger error: ${message}`);
    resultsView.postMessage({ type: 'timeline-error', message });
  }
}

function _resolveProjectRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot');
  if (configured?.trim()) { return configured.trim(); }
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) { return folders[0].uri.fsPath; }
  return undefined;
}

function focusResult(
  fileId: string,
  nodeId: string,
  store: ResultStore,
  selection: SelectionState,
  resultsView: ResultsView,
): void {
  vscode.commands.executeCommand('liveTestRunner.results.focus');
  const node = store.getNode(nodeId);
  const scope = node?.type === 'test' ? 'test' : node?.type === 'suite' ? 'suite' : 'file';
  selection.select({ scope, fileId, nodeId });
  resultsView.postMessage({ type: 'scope-changed', scope, fileId, nodeId });
}
