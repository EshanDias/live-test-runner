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
import { LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR } from './constants';
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
import { buildDiagnosticReport } from './utils/diagnostics';

const log = logger.scope('Extension');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Alive but no permission to signal
  }
}

export function activate(context: vscode.ExtensionContext) {
  // ── Output channels (created first so every later log line has a home) ─────
  // "Live Test Runner"             — structured, levelled extension log
  // "Live Test Runner: Jest Output" — raw Jest process output, ANSI-stripped
  const logChannel    = vscode.window.createOutputChannel('Live Test Runner', { log: true });
  const outputChannel = vscode.window.createOutputChannel('Live Test Runner: Jest Output');
  logger.init(logChannel);

  // End-to-end tests (e2e/ at the repo root) read the raw Jest output.
  const e2eRawOutput: string[] | undefined = process.env.LTR_E2E ? [] : undefined;
  if (e2eRawOutput) {
    const appendLine = outputChannel.appendLine.bind(outputChannel);
    outputChannel.appendLine = (line: string) => { e2eRawOutput.push(line); appendLine(line); };
  }

  const extVersion = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '?';
  log.info(
    `Live Test Runner v${extVersion} · VS Code ${vscode.version} · ${process.platform}-${process.arch} · Node ${process.versions.node}`,
  );

  // Ensure the shared base directories exist up front so no path checks fail later.
  for (const dir of [LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error(`Could not create ${dir}`, err);
    }
  }

  // Clean up stale session directories from previous or crashed windows.
  let removedDirs = 0;
  try {
    for (const entry of fs.readdirSync(LTR_BASE_TMP_DIR)) {
      const fullPath = path.join(LTR_BASE_TMP_DIR, entry);

      // Handle new-style session directories: session-<pid>-<timestamp>
      const sessionMatch = entry.match(/^session-(\d+)-/);
      if (sessionMatch) {
        const pid = parseInt(sessionMatch[1], 10);
        if (!isProcessAlive(pid)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedDirs++;
        }
        continue;
      }

      // Handle legacy trace directories (blindly clean up to migrate)
      if (entry.startsWith('traces-')) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        removedDirs++;
      }
    }
  } catch (err) {
    log.warn('Stale session cleanup failed — continuing', err);
  }
  if (removedDirs > 0) { log.debug(`Removed ${removedDirs} stale session folder(s) from ${LTR_BASE_TMP_DIR}`); }

  // Create a unique isolated directory for THIS session.
  const sessionDirName = `session-${process.pid}-${Date.now()}`;
  const LTR_SESSION_TMP_DIR = path.join(LTR_BASE_TMP_DIR, sessionDirName);
  try {
    fs.mkdirSync(LTR_SESSION_TMP_DIR, { recursive: true });
    log.debug(`Session temp folder: ${LTR_SESSION_TMP_DIR}`);
  } catch (err) {
    log.error(`Could not create session temp folder ${LTR_SESSION_TMP_DIR} — runs will fail`, err);
  }

  // ── Infrastructure ─────────────────────────────────────────────────────────
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
  const instrumentedRunner: IInstrumentedRunner = new JestInstrumentedRunner(
    LTR_SESSION_TMP_DIR,
    (msg) => outputChannel.appendLine(msg),
  );
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
        log.warn(`Timeline: could not decorate step ${stepId} at ${filePath}:${line}`, err);
      });
    } else {
      timelineDecorations.highlight(filePath, line).catch((err) => {
        log.warn(`Timeline: could not highlight ${filePath}:${line}`, err);
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
    discoveryCache = new DiscoveryCache(LTR_BASE_CACHE_DIR, activationRoot);
    discoveryCache.writeLock();
  }

  // ── Session manager ────────────────────────────────────────────────────────
  const discovery = new TestDiscoveryService();

  const discoveryCallbacks = {
    onFilesFound: (total: number) => {
      observers.forEach((o) => o.onDiscoveryStarted?.(total));
    },
    onBatchDiscovered: (files: unknown[], discovered: number, total: number) => {
      observers.forEach((o) => o.onDiscoveryProgress?.(files, discovered, total));
    },
    onComplete: () => {
      observers.forEach((o) => o.onDiscoveryComplete?.());
    },
    onFileRemoved: (fileId: string) => {
      observers.forEach((o) => o.onDiscoveryFileRemoved?.(fileId));
    },
  };

  // Kick off static discovery immediately on activate so tests appear in the
  // sidebar before the user clicks Start Testing.
  if (activationRoot) {
    log.info(`Project root: ${activationRoot}`);
    discovery.start(activationRoot, store, discoveryCallbacks, discoveryCache);
  } else {
    log.info('No project root yet — open a single folder or run "Live Test Runner: Select Project Root"');
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
        const cap = rotateAndCheckCapacity(LTR_BASE_CACHE_DIR);
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
        log.info('Session stopped and discovery cache cleared');
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
        log.info('Discovery cache cleared — rediscovering tests');
        discovery.start(activationRoot, store, discoveryCallbacks, discoveryCache);
        vscode.window.showInformationMessage('Live Test Runner: Cache cleared. Click Start Testing to run.');
      }
    }),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot',  () => session.selectProjectRoot()),
    vscode.commands.registerCommand('liveTestRunner.showOutput',         () => outputChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.showLogs',           () => logChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.copyDiagnostics',    async () => {
      const report = buildDiagnosticReport({
        extensionVersion: extVersion,
        projectRoot:      _resolveProjectRoot(),
        sessionActive:    session.isActive(),
        sessionDir:       LTR_SESSION_TMP_DIR,
        summary:          store.getSummary(),
        logLevel:         logger.level,
        recentLogLines:   logger.recentLines(),
      });
      await vscode.env.clipboard.writeText(report);
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(
        'Live Test Runner: diagnostic report copied to the clipboard. Check it for anything private before sharing.',
      );
    }),
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
      return openTimelineDebugger(filePath, testFullName, instrumentedRunner, resultsView, explorerView, lastTimelineOptions,
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
      logChannel.info(traceStore.dump());
      logChannel.show();
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
    { dispose: () => logger.dispose() },
    logChannel,
  );

  // Internals for the end-to-end tests only — never returned in normal use.
  if (e2eRawOutput) {
    return {
      store, session, traceStore, coverageStore, discovery, observers, statusBar,
      instrumentedRunner, logger, rawOutput: e2eRawOutput, sessionDir: LTR_SESSION_TMP_DIR,
    };
  }
  return undefined;
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
  try {
    const entry = store.getLineMap(filePath).get(line);
    if (entry) {
      const node = store.getNode(entry.nodeId);
      if (node) {
        log.debug(`Rerun from editor: ${node.type} "${node.fullName}"`);
        session.rerunScope({ scope: node.type, fileId: entry.fileId, nodeId: entry.nodeId, fullName: node.fullName });
        return;
      }
    }
    // describe blocks might not be in the LineMap at this exact line.
    // Try to extract the suite title from the source line and find the matching node.
    const nodeId = await _resolveNodeAtLine(filePath, line, store);
    if (nodeId) {
      const node = store.getNode(nodeId);
      log.debug(`Rerun from editor: suite "${node?.fullName}"`);
      session.rerunScope({ scope: 'suite', fileId: filePath, nodeId, fullName: node?.fullName });
      return;
    }
    log.debug(`Rerun from editor: no test at ${path.basename(filePath)}:${line} — running the whole file`);
    session.rerunScope({ scope: 'file', fileId: filePath });
  } catch (err) {
    log.error(`Rerun from editor failed for ${filePath}:${line}`, err);
  }
}

async function debugFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<vscode.DebugConfiguration | undefined> {
  try {
    const entry = store.getLineMap(filePath).get(line);
    const nodeId = entry?.nodeId ?? await _resolveNodeAtLine(filePath, line, store);
    const node = nodeId ? store.getNode(nodeId) : undefined;
    // A suite (describe block or .each template) runs every test inside it.
    return await session.debugFromEditor(filePath, node?.fullName, node ? node.type === 'suite' : false);
  } catch (err) {
    log.error(`Debug from editor failed for ${filePath}:${line}`, err);
    return undefined;
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
    log.debug(`Could not resolve a describe block at ${filePath}:${line} — ${(err as Error).message}`);
    return undefined;
  }
}

async function openTimelineDebugger(
  filePath: string,
  testFullName: string,
  runner: IInstrumentedRunner,
  resultsView: ResultsView,
  explorerView: ExplorerView,
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

  const tlog = logger.scope('Timeline');
  const startedAt = Date.now();
  tlog.info(`Tracing "${testFullName}" (${path.basename(filePath)})`);

  try {
    const store = await runner.run({ filePath, testFullName, projectRoot });

    // Convert Maps to plain objects for postMessage serialisation (Maps are not
    // JSON-serialisable and webviews receive messages via JSON.stringify).
    const serialisableStore = {
      ...store,
      variables: Object.fromEntries(store.variables),
      logs:      Object.fromEntries(store.logs),
    };

    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (store.steps.length === 0) {
      // Nothing recorded almost always means the test name pattern matched no
      // test, or the trace transform did not apply to the file.
      tlog.warn(`Trace finished in ${secs}s but captured 0 steps for "${testFullName}" — see "Live Test Runner: Jest Output" for Jest's output`);
    } else {
      tlog.info(`Trace done in ${secs}s — ${store.steps.length} steps, ${store.errors.length} error(s)`);
    }
    onStoreReady?.(serialisableStore as { steps: unknown[]; variables: Record<number, unknown[]> });
    resultsView.postMessage({ type: 'timeline-ready', store: serialisableStore });
    explorerView.postMessage({ type: 'timeline-ready', store: serialisableStore });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    tlog.error(`Trace failed for "${testFullName}"`, err);
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
