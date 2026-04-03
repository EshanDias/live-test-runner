import * as vscode from 'vscode';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';
import { TestSession } from '@live-test-runner/core';
import { ResultStore, TestStatus } from './ResultStore';
import { SelectionState } from './SelectionState';
import { TestExplorerProvider } from './TestExplorerProvider';
import { TestResultsProvider } from './TestResultsProvider';

// ── Module-level singletons ───────────────────────────────────────────────────
let testSession: TestSession | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let resultStore: ResultStore;
let selectionState: SelectionState;
let explorerProvider: TestExplorerProvider;
let resultsProvider: TestResultsProvider;

// ── Activate ──────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');
  statusBarItem.show();

  outputChannel = vscode.window.createOutputChannel('Live Test Runner', 'ansi');

  resultStore    = new ResultStore();
  selectionState = new SelectionState();

  explorerProvider = new TestExplorerProvider(context.extensionUri, resultStore, selectionState);
  resultsProvider  = new TestResultsProvider(context.extensionUri, resultStore, selectionState);

  // When selection changes, push scoped data to results panel
  const origSelect = selectionState.select.bind(selectionState);
  selectionState.select = (sel) => {
    origSelect(sel);
    resultsProvider.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TestExplorerProvider.viewId, explorerProvider),
    vscode.window.registerWebviewViewProvider(TestResultsProvider.viewId, resultsProvider),

    vscode.commands.registerCommand('liveTestRunner.startTesting', startTesting),
    vscode.commands.registerCommand('liveTestRunner.stopTesting', stopTesting),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot', selectProjectRoot),
    vscode.commands.registerCommand('liveTestRunner.showOutput', () => outputChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.rerunScope', rerunScope),

    vscode.workspace.onDidSaveTextDocument(onSave),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (testSession) {
        testSession.stop();
        testSession = undefined;
        resultStore.clear();
        updateStatusBar('Off');
        broadcast({ type: 'run-finished', total: 0, passed: 0, failed: 0 });
      }
    }),

    outputChannel,
    statusBarItem,
  );
}

export function deactivate() {
  if (testSession) testSession.stop();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcast(msg: unknown): void {
  explorerProvider.postMessage(msg);
  resultsProvider.postMessage(msg);
}

function getProjectRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot');
  if (configured?.trim()) return configured.trim();
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) return folders[0].uri.fsPath;
  return undefined;
}

function getJestCommand(): string {
  return vscode.workspace.getConfiguration('liveTestRunner').get<string>('jestCommand') || '';
}

function updateStatusBar(text: string) {
  statusBarItem.text = `Live Tests: ${text}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function startTesting() {
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    const pick = await vscode.window.showErrorMessage(
      'No project root found. Open a single folder or configure liveTestRunner.projectRoot.',
      'Select Project Root'
    );
    if (pick) await selectProjectRoot();
    return;
  }

  if (testSession) { testSession.stop(); testSession = undefined; }

  outputChannel.show(true);
  outputChannel.appendLine('');
  outputChannel.appendLine(`[Live Test Runner] Starting — ${projectRoot}`);

  const runner = new JestRunner(getJestCommand(), (msg) => outputChannel.appendLine(msg));
  testSession = new TestSession(runner);

  try {
    updateStatusBar('Discovering…');

    const testFiles = await runner.discoverTests(projectRoot);
    outputChannel.appendLine(`[Live Test Runner] Found ${testFiles.length} test file(s)`);

    if (testFiles.length === 0) {
      updateStatusBar('✅ Ready');
      testSession.activate();
      return;
    }

    testSession.activate();
    await runFiles(testFiles, projectRoot);

  } catch (error) {
    updateStatusBar('❌ Error');
    vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
  }
}

function stopTesting() {
  if (testSession) { testSession.stop(); testSession = undefined; }
  updateStatusBar('Off');
}

async function selectProjectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { vscode.window.showErrorMessage('No workspace folders are open.'); return; }

  let selected: string | undefined;
  if (folders.length === 1) {
    selected = folders[0].uri.fsPath;
  } else {
    selected = await vscode.window.showQuickPick(
      folders.map((f: vscode.WorkspaceFolder) => f.uri.fsPath),
      { placeHolder: 'Select project root' }
    );
  }

  if (selected) {
    await vscode.workspace.getConfiguration('liveTestRunner').update(
      'projectRoot', selected, vscode.ConfigurationTarget.Workspace
    );
  }
}

async function rerunScope(args: { scope: string; fileId: string; suiteId?: string; testId?: string }) {
  const projectRoot = getProjectRoot();
  if (!projectRoot) return;
  await runFiles([args.fileId], projectRoot);
}

// ── On-save ───────────────────────────────────────────────────────────────────
async function onSave(document: vscode.TextDocument) {
  if (!testSession?.isTestingActive()) return;

  const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get<number>('onSaveDebounceMs') ?? 300;

  setTimeout(async () => {
    if (!testSession) return;
    try {
      const runner = testSession.getRunner() as JestRunner;
      const projectRoot = getProjectRoot();
      if (!projectRoot) return;

      let filesToRun: string[];

      if (runner.isTestFile(document.uri.fsPath)) {
        filesToRun = [document.uri.fsPath];
      } else {
        const affected = testSession.getCoverageMap().getAffectedTests(document.uri.fsPath);
        filesToRun = affected.size > 0 ? Array.from(affected) : [];
        if (filesToRun.length === 0) return;
      }

      await runFiles(filesToRun, projectRoot);
    } catch (error) {
      updateStatusBar('✅ Ready');
      outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
    }
  }, debounceMs);
}

// ── Core run function ─────────────────────────────────────────────────────────
async function runFiles(filePaths: string[], projectRoot: string): Promise<void> {
  const CONCURRENCY = 3;
  const queue = [...filePaths];
  let completed = 0;
  let numPassed = 0;
  let numFailed = 0;

  for (const fp of filePaths) {
    const name = vscode.workspace.asRelativePath(fp);
    resultStore.fileStarted(fp, fp, name);
    broadcast({ type: 'file-started', fileId: fp, filePath: fp, name });
  }

  broadcast({ type: 'run-started', fileCount: filePaths.length });
  updateStatusBar(`Running… 0/${filePaths.length}`);

  const totalStart = Date.now();

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, async () => {
      const poolRunner = new JestRunner(getJestCommand(), (msg) => outputChannel.appendLine(msg));
      poolRunner.setProjectRoot(projectRoot);

      while (true) {
        const filePath = queue.shift();
        if (!filePath) break;

        try {
          const jsonResult = await poolRunner.runTestFileJson(filePath);
          const fileResult = jsonResult.fileResults[0];

          if (fileResult) {
            applyFileResultToStore(filePath, fileResult);
            if (fileResult.status === 'passed') numPassed++; else numFailed++;
          } else {
            resultStore.fileResult(filePath, 'failed');
            numFailed++;
          }
        } catch (error) {
          resultStore.fileResult(filePath, 'failed');
          numFailed++;
        }

        completed++;
        updateStatusBar(`Running… ${completed}/${filePaths.length}`);
        broadcastFileResult(filePath);
      }
    })
  );

  outputChannel.appendLine(`[Live Test Runner] Finished in ${Date.now() - totalStart}ms`);

  const summary = resultStore.getSummary();
  broadcast({ type: 'run-finished', total: summary.total, passed: summary.passed, failed: summary.failed });

  if (numFailed > 0) {
    updateStatusBar(`❌ ${numFailed} failed, ${numPassed} passed`);
  } else if (numPassed > 0) {
    updateStatusBar(`✅ ${numPassed} passed`);
  }
}

function broadcastFileResult(filePath: string): void {
  const fileData = resultStore.getFile(filePath);
  if (!fileData) return;
  const summary = resultStore.getSummary();
  broadcast({
    type: 'full-file-result',
    file: {
      fileId: fileData.fileId,
      filePath: fileData.filePath,
      name: fileData.name,
      status: fileData.status,
      duration: fileData.duration,
      outputLines: fileData.outputLines,
      suites: Array.from(fileData.suites.values()).map(s => ({
        suiteId: s.suiteId,
        name: s.name,
        status: s.status,
        duration: s.duration,
        tests: Array.from(s.tests.values()).map(t => ({
          testId: t.testId,
          name: t.name,
          status: t.status,
          duration: t.duration,
          failureMessages: t.failureMessages,
        })),
      })),
    },
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
  });
}

// ── Map JestFileResult into ResultStore ───────────────────────────────────────
function applyFileResultToStore(filePath: string, fileResult: JestFileResult): void {
  const suiteCounters = new Map<string, number>();

  for (const tc of fileResult.testCases) {
    const suiteKey = tc.ancestorTitles.join(' > ') || '(root)';
    const suiteId  = `${filePath}::${suiteKey}`;

    if (!resultStore.getSuite(filePath, suiteId)) {
      resultStore.suiteStarted(filePath, suiteId, suiteKey);
    }

    const count = (suiteCounters.get(suiteId) ?? 0) + 1;
    suiteCounters.set(suiteId, count);
    const testId = `${suiteId}::${tc.fullName || tc.title}::${count}`;

    resultStore.testStarted(filePath, suiteId, testId, tc.title);

    const status: TestStatus =
      tc.status === 'passed'  ? 'passed'  :
      tc.status === 'failed'  ? 'failed'  :
      tc.status === 'skipped' ? 'skipped' : 'pending';

    resultStore.testResult(filePath, suiteId, testId, status, tc.duration, tc.failureMessages ?? []);
  }

  // Roll up suite statuses
  const file = resultStore.getFile(filePath);
  if (file) {
    for (const suite of file.suites.values()) {
      const tests = Array.from(suite.tests.values());
      const suiteStatus: TestStatus = tests.some(t => t.status === 'failed') ? 'failed' : 'passed';
      const suiteDur = tests.reduce((acc, t) => acc + (t.duration ?? 0), 0);
      resultStore.suiteResult(filePath, suite.suiteId, suiteStatus, suiteDur);
    }
  }

  // Map Jest console entries to OutputLine[] and store at file level
  if (fileResult.consoleOutput && fileResult.consoleOutput.length > 0) {
    const outputLines = fileResult.consoleOutput.map(entry => ({
      text: entry.message,
      level: (entry.type === 'warn' ? 'warn' : entry.type === 'log' ? 'log' : 'info') as 'log' | 'info' | 'warn',
    }));
    resultStore.fileOutput(filePath, outputLines);
  }

  resultStore.fileResult(filePath, fileResult.status === 'passed' ? 'passed' : 'failed', fileResult.duration);
}
