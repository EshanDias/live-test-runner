import * as vscode from 'vscode';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';
import { TestSession } from '@live-test-runner/core';
import { ResultStore, TestStatus } from './ResultStore';
import { SelectionState } from './SelectionState';
import { TestExplorerProvider } from './TestExplorerProvider';
import { TestResultsProvider } from './TestResultsProvider';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\u001b[0m',
  bold:   '\u001b[1m',
  green:  '\u001b[92m',
  yellow: '\u001b[33m',
  red:    '\u001b[31m',
  cyan:   '\u001b[36m',
};

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const LTR_PLAIN = '[Live Test Runner]';

function colorDuration(ms: number): string {
  if (ms >= 10_000) return `${C.red}${C.bold}${ms}ms ⚠${C.reset}`;
  if (ms >= 3_000)  return `${C.yellow}${ms}ms${C.reset}`;
  return `${C.green}${ms}ms${C.reset}`;
}

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
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');
  statusBarItem.show();

  // Raw output channel (ANSI)
  outputChannel = vscode.window.createOutputChannel('Live Test Runner');

  // Core state
  resultStore   = new ResultStore();
  selectionState = new SelectionState();

  // Webview providers
  explorerProvider = new TestExplorerProvider(context.extensionUri, resultStore, selectionState);
  resultsProvider  = new TestResultsProvider(context.extensionUri, resultStore, selectionState);

  // Wire: when selection changes, push scoped data to results panel
  const origSelect = selectionState.select.bind(selectionState);
  selectionState.select = (sel) => {
    origSelect(sel);
    resultsProvider.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
  };

  context.subscriptions.push(
    // Webview providers
    vscode.window.registerWebviewViewProvider(TestExplorerProvider.viewId, explorerProvider),
    vscode.window.registerWebviewViewProvider(TestResultsProvider.viewId, resultsProvider),

    // Commands
    vscode.commands.registerCommand('liveTestRunner.startTesting', startTesting),
    vscode.commands.registerCommand('liveTestRunner.stopTesting', stopTesting),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot', selectProjectRoot),
    vscode.commands.registerCommand('liveTestRunner.showOutput', () => outputChannel.show()),
    vscode.commands.registerCommand('liveTestRunner.rerunScope', rerunScope),

    // On-save trigger
    vscode.workspace.onDidSaveTextDocument(onSave),

    // Clean up on workspace change
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (testSession) {
        testSession.stop();
        testSession = undefined;
        resultStore.clear();
        updateStatusBar('Off');
        broadcast({ type: 'run-started', fileCount: 0 });
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

// ── Broadcast to both webviews ────────────────────────────────────────────────
function broadcast(msg: unknown): void {
  explorerProvider.postMessage(msg);
  resultsProvider.postMessage(msg);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function log(msg: string) {
  outputChannel.appendLine(`${LTR_PLAIN} ${msg}`);
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
  log('── Starting ──────────────────────────────────────────');
  log(`Project root : ${projectRoot}`);
  log(`Jest command : ${getJestCommand() || '(auto-detect)'}`);

  const runner = new JestRunner(getJestCommand(), (msg) => outputChannel.appendLine(stripAnsi(msg)));
  testSession = new TestSession(runner);

  try {
    updateStatusBar('Discovering…');
    log('Discovering tests…');

    const testFiles = await runner.discoverTests(projectRoot);
    log(`Found ${testFiles.length} test file(s)`);

    if (testFiles.length === 0) {
      log('No test files found.');
      updateStatusBar('✅ Ready');
      testSession.activate();
      return;
    }

    testSession.activate();
    await runFiles(testFiles, projectRoot);

  } catch (error) {
    updateStatusBar('❌ Error');
    log(`Error: ${error}`);
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
  // For now, rerun the whole file — suite/test granularity can be added later
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
      log(`Error: ${(error as Error).message}`);
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

  // Mark all files as running in the store
  for (const fp of filePaths) {
    const name = vscode.workspace.asRelativePath(fp);
    resultStore.fileStarted(fp, fp, name);
  }

  broadcast({ type: 'run-started', fileCount: filePaths.length });
  updateStatusBar(`Running… 0/${filePaths.length}`);
  log(`Running ${filePaths.length} test file(s)…`);

  const totalStart = Date.now();

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, filePaths.length) }, async () => {
      const poolRunner = new JestRunner(getJestCommand(), (msg) => outputChannel.appendLine(stripAnsi(msg)));
      poolRunner.setProjectRoot(projectRoot);

      while (true) {
        const filePath = queue.shift();
        if (!filePath) break;

        const relPath = vscode.workspace.asRelativePath(filePath);

        try {
          const jsonResult = await poolRunner.runTestFileJson(filePath);
          const fileResult = jsonResult.fileResults[0];

          if (fileResult) {
            applyFileResultToStore(filePath, fileResult);

            const statusTag = fileResult.status === 'passed'
              ? `${C.green}${C.bold}PASS${C.reset}`
              : `${C.red}${C.bold}FAIL${C.reset}`;
            const dur = fileResult.duration;
            const durationStr = dur != null && dur > 0 ? ` ${colorDuration(dur)}` : '';
            log(`${statusTag} ${relPath}${durationStr}`);

            if (fileResult.status === 'passed') numPassed++; else numFailed++;
          } else {
            const msg = jsonResult.errors.join('\n') || 'No results returned';
            resultStore.fileResult(filePath, 'failed');
            log(`${C.red}${C.bold}ERROR${C.reset} ${relPath}: ${msg}`);
            numFailed++;
          }
        } catch (error) {
          resultStore.fileResult(filePath, 'failed');
          log(`${C.red}ERROR${C.reset} ${relPath}: ${(error as Error).message}`);
          numFailed++;
        }

        completed++;
        updateStatusBar(`Running… ${completed}/${filePaths.length}`);

        // Push full file tree to webviews
        const fileData = resultStore.getFile(filePath);
        const summary = resultStore.getSummary();
        if (fileData) {
          const fileJson = {
            fileId: fileData.fileId,
            filePath: fileData.filePath,
            name: fileData.name,
            status: fileData.status,
            duration: fileData.duration,
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
          };
          broadcast({
            type: 'full-file-result',
            file: fileJson,
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
          });
        }
      }
    })
  );

  const totalDur = Date.now() - totalStart;
  log(`Finished in ${colorDuration(totalDur)}`);

  const summary = resultStore.getSummary();
  broadcast({ type: 'run-finished', total: summary.total, passed: summary.passed, failed: summary.failed });

  if (numFailed > 0) {
    updateStatusBar(`❌ ${numFailed} failed, ${numPassed} passed`);
  } else if (numPassed > 0) {
    updateStatusBar(`✅ ${numPassed} passed`);
  }
}

// ── Map JestFileResult into ResultStore ───────────────────────────────────────
function applyFileResultToStore(filePath: string, fileResult: JestFileResult): void {
  const suiteCounters = new Map<string, number>();

  for (const tc of fileResult.testCases) {
    // Build a stable suiteId from ancestor path
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

    // Store console output lines (Jest puts them in failureDetails — approximate as output)
  }

  // Roll up suite statuses
  const file = resultStore.getFile(filePath);
  if (file) {
    for (const suite of file.suites.values()) {
      const tests = Array.from(suite.tests.values());
      const hasFailed  = tests.some(t => t.status === 'failed');
      const suiteStatus: TestStatus = hasFailed ? 'failed' : 'passed';
      const suiteDur = tests.reduce((acc, t) => acc + (t.duration ?? 0), 0);
      resultStore.suiteResult(filePath, suite.suiteId, suiteStatus, suiteDur);
    }
  }

  const jestStatus: TestStatus = fileResult.status === 'passed' ? 'passed' : 'failed';
  resultStore.fileResult(filePath, jestStatus, fileResult.duration);
}
