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
import { ResultStore } from './store/ResultStore';
import { SelectionState } from './store/SelectionState';
import { JestAdapter } from './framework/JestAdapter';
import { CodeLensProvider } from './editor/CodeLensProvider';
import { DecorationManager } from './editor/DecorationManager';
import { ExplorerView } from './views/ExplorerView';
import { ResultsView } from './views/ResultsView';
import { SessionManager } from './session/SessionManager';
import { IInstrumentedRunner } from './timeline/IInstrumentedRunner';
import { JestInstrumentedRunner } from './timeline/JestInstrumentedRunner';

export function activate(context: vscode.ExtensionContext) {
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
  const decorationManager = new DecorationManager(store, context);
  const codeLensProvider  = new CodeLensProvider(store);
  const observers         = [explorerView, resultsView, decorationManager, codeLensProvider];

  // When selection changes, push scoped logs to the results view
  const origSelect = selection.select.bind(selection);
  selection.select = (sel) => {
    origSelect(sel);
    resultsView.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
  };

  // ── Timeline debugger ──────────────────────────────────────────────────────
  // Reference typed as the interface — never as the concrete class.
  const instrumentedRunner: IInstrumentedRunner = new JestInstrumentedRunner();

  // ── Session manager ────────────────────────────────────────────────────────
  const session = new SessionManager(
    context,
    new JestAdapter(),
    store,
    selection,
    resultsView,
    observers,
    outputChannel,
    statusBar,
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerView.viewId, explorerView),
    vscode.window.registerWebviewViewProvider(ResultsView.viewId, resultsView),

    vscode.commands.registerCommand('liveTestRunner.startTesting',       () => session.start()),
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
    vscode.commands.registerCommand('liveTestRunner.focusResult',        (fileId, suiteId, testId) => focusResult(fileId, suiteId, testId, selection, resultsView)),
    vscode.commands.registerCommand('liveTestRunner.openTimelineDebugger', (filePath: string, testFullName: string) =>
      openTimelineDebugger(filePath, testFullName, instrumentedRunner, resultsView, explorerView, outputChannel)),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) { decorationManager.applyToEditor(editor); }
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => session.onSave(doc)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.onWorkspaceFoldersChanged()),

    outputChannel,
    statusBar,
  );
}

export function deactivate() {}

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
    const test = store.getTest(entry.fileId, entry.suiteId, entry.testId);
    if (test) {
      session.rerunScope({ scope: 'test', fileId: entry.fileId, suiteId: entry.suiteId, testId: entry.testId, fullName: test.fullName });
      return;
    }
  }
  // describe blocks are not in the LineMap (Jest doesn't report their location).
  // Try to extract the suite title from the source line and find the matching suite.
  const suiteId = await _resolveSuiteAtLine(filePath, line, store);
  if (suiteId) {
    const suite = store.getSuite(filePath, suiteId);
    session.rerunScope({ scope: 'suite', fileId: filePath, suiteId, fullName: suite?.name });
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
    const testFullName = store.getTest(entry.fileId, entry.suiteId, entry.testId)?.fullName;
    await session.debugFromEditor(filePath, testFullName);
    return;
  }
  // describe block — use suite name as testNamePattern so Jest runs all tests within it
  const suiteId = await _resolveSuiteAtLine(filePath, line, store);
  const suiteName = suiteId ? store.getSuite(filePath, suiteId)?.name : undefined;
  await session.debugFromEditor(filePath, suiteName);
}

/** Extracts the describe title from a source line and looks it up in the store. */
async function _resolveSuiteAtLine(
  filePath: string,
  line: number,
  store: ResultStore,
): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const lineText = doc.lineAt(line - 1).text;
    const m = lineText.match(/describe\s*[\.(]\s*['"`]([^'"`]+)['"`]/);
    if (!m) { return undefined; }
    const suiteId = `${filePath}::${m[1]}`;
    return store.getSuite(filePath, suiteId) ? suiteId : undefined;
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
  suiteId: string,
  testId: string,
  selection: SelectionState,
  resultsView: ResultsView,
): void {
  vscode.commands.executeCommand('liveTestRunner.results.focus');
  selection.select({ scope: 'test', fileId, suiteId, testId });
  resultsView.postMessage({ type: 'scope-changed', scope: 'test', fileId, suiteId, testId });
}
