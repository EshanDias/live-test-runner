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
import { LTR_TMP_DIR } from './constants';
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

export function activate(context: vscode.ExtensionContext) {
  // Ensure the shared temp directory exists as early as possible.
  // All runners write temp files here; creating it once avoids any race where
  // a runner tries to write before the directory exists.
  fs.mkdirSync(LTR_TMP_DIR, { recursive: true });

  // Clean up stale traces-* directories left over from previous sessions.
  try {
    for (const entry of fs.readdirSync(LTR_TMP_DIR)) {
      if (entry.startsWith('traces-')) {
        fs.rmSync(path.join(LTR_TMP_DIR, entry), { recursive: true, force: true });
      }
    }
  } catch { /* ignore */ }

  // ── Infrastructure ─────────────────────────────────────────────────────────
  const outputChannel  = vscode.window.createOutputChannel('Live Test Runner', 'ansi');
  const statusBar      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command    = 'liveTestRunner.showPanels';
  statusBar.text       = 'Live Tests: Off';
  statusBar.show();

  // ── State ──────────────────────────────────────────────────────────────────
  const store     = new ResultStore();
  const selection = new SelectionState();

  // ── Views and editor providers ─────────────────────────────────────────────
  const explorerView      = new ExplorerView(context.extensionUri, store, selection);
  const resultsView       = new ResultsView(context.extensionUri, store, selection);
  const decorationManager = new DecorationManager(store);
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
  const instrumentedRunner: IInstrumentedRunner = new JestInstrumentedRunner();
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
      ).catch(() => {});
    } else {
      timelineDecorations.highlight(filePath, line).catch(() => {});
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

  // ── Execution trace store + trace directory ────────────────────────────────
  const traceStore = new ExecutionTraceStore();
  const traceDir   = path.join(LTR_TMP_DIR, `traces-${Date.now()}`);

  function cleanTraceDir() {
    try { fs.rmSync(traceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    traceStore.clearAll();
  }

  // ── Session manager ────────────────────────────────────────────────────────
  const discovery = new TestDiscoveryService();

  // Kick off static discovery immediately on activate so tests appear in the
  // sidebar before the user clicks Start Testing.
  const activationRoot = _resolveProjectRoot();
  if (activationRoot) {
    discovery.start(activationRoot, store, (msg) => outputChannel.appendLine(msg), {
      onFilesFound: (total) => {
        observers.forEach((o) => o.onDiscoveryStarted?.(total));
      },
      onFileDiscovered: (file, discovered, total) => {
        observers.forEach((o) => o.onDiscoveryProgress?.(file, discovered, total));
      },
      onComplete: () => {
        observers.forEach((o) => o.onDiscoveryComplete?.());
      },
    });
  }

  const session = new SessionManager(
    new JestAdapter(),
    store,
    traceStore,
    selection,
    resultsView,
    observers,
    outputChannel,
    statusBar,
    discovery,
    traceDir,
  );

  // Expose cleanup so deactivate() can delete trace files on extension shutdown
  _cleanTraceDir = cleanTraceDir;

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerView.viewId, explorerView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, resultsView, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('liveTestRunner.startTesting',       () => { cleanTraceDir(); return session.start(); }),
    vscode.commands.registerCommand('liveTestRunner.stopTesting',        () => session.stop(decorationManager)),
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

    vscode.workspace.onDidSaveTextDocument((doc) => session.onSave(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.onWorkspaceFoldersChanged()),

    outputChannel,
    statusBar,
    { dispose: () => timelineDecorations.dispose() },
  );
}

let _cleanTraceDir: (() => void) | undefined;
export function deactivate() {
  _cleanTraceDir?.();
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
  const entry = store.getLineMap(filePath).get(line);
  if (entry) {
    const node = store.getNode(entry.nodeId);
    if (node) {
      session.rerunScope({ scope: node.type, fileId: entry.fileId, nodeId: entry.nodeId, fullName: node.fullName });
      return;
    }
  }
  // describe blocks might not be in the LineMap at this exact line.
  // Try to extract the suite title from the source line and find the matching node.
  const nodeId = await _resolveNodeAtLine(filePath, line, store);
  if (nodeId) {
    const node = store.getNode(nodeId);
    session.rerunScope({ scope: 'suite', fileId: filePath, nodeId, fullName: node?.fullName });
    return;
  }
  session.rerunScope({ scope: 'file', fileId: filePath });
}

async function debugFromEditor(
  filePath: string,
  line: number,
  store: ResultStore,
  session: SessionManager,
): Promise<void> {
  const entry = store.getLineMap(filePath).get(line);
  if (entry) {
    const node = store.getNode(entry.nodeId);
    await session.debugFromEditor(filePath, node?.fullName);
    return;
  }
  // describe block — use node fullName as testNamePattern so Jest runs all tests within it
  const nodeId = await _resolveNodeAtLine(filePath, line, store);
  const fullName = nodeId ? store.getNode(nodeId)?.fullName : undefined;
  await session.debugFromEditor(filePath, fullName);
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
  } catch {
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
    onStoreReady?.(serialisableStore as { steps: unknown[]; variables: Record<number, unknown[]> });
    resultsView.postMessage({ type: 'timeline-ready', store: serialisableStore });
    explorerView.postMessage({ type: 'timeline-ready', store: serialisableStore });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[Timeline] Error: ${message}`);
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
