import * as vscode from 'vscode';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';
import { TestSession } from '@live-test-runner/core';
import {
  ResultStore,
  TestStatus,
  OutputLevel,
  OutputLine,
  ScopedOutput,
  LineEntry,
} from './ResultStore';
import { SelectionState } from './SelectionState';
import { TestExplorerProvider } from './TestExplorerProvider';
import { TestResultsProvider } from './TestResultsProvider';
import { EditorDecorationManager } from './EditorDecorationManager';
import { LiveTestCodeLensProvider } from './CodeLensProvider';

// ── Module-level singletons ───────────────────────────────────────────────────
let testSession: TestSession | undefined;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let resultStore: ResultStore;
let selectionState: SelectionState;
let explorerProvider: TestExplorerProvider;
let resultsProvider: TestResultsProvider;
let decorationManager: EditorDecorationManager;
let codeLensProvider: LiveTestCodeLensProvider;
let codeLensDisposable: vscode.Disposable | undefined;
let extensionContext: vscode.ExtensionContext;

// ── Activate ──────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');
  statusBarItem.show();

  outputChannel = vscode.window.createOutputChannel('Live Test Runner', 'ansi');

  resultStore = new ResultStore();
  selectionState = new SelectionState();
  decorationManager = new EditorDecorationManager(resultStore, context);
  codeLensProvider  = new LiveTestCodeLensProvider(resultStore);

  explorerProvider = new TestExplorerProvider(
    context.extensionUri,
    resultStore,
    selectionState,
  );
  resultsProvider = new TestResultsProvider(
    context.extensionUri,
    resultStore,
    selectionState,
  );

  // When selection changes, push scoped data to results panel
  const origSelect = selectionState.select.bind(selectionState);
  selectionState.select = (sel) => {
    origSelect(sel);
    resultsProvider.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TestExplorerProvider.viewId,
      explorerProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      TestResultsProvider.viewId,
      resultsProvider,
    ),

    vscode.commands.registerCommand(
      'liveTestRunner.startTesting',
      startTesting,
    ),
    vscode.commands.registerCommand('liveTestRunner.stopTesting', stopTesting),
    vscode.commands.registerCommand(
      'liveTestRunner.selectProjectRoot',
      selectProjectRoot,
    ),
    vscode.commands.registerCommand('liveTestRunner.showOutput', () =>
      outputChannel.show(),
    ),
    vscode.commands.registerCommand('liveTestRunner.rerunScope', rerunScope),
    vscode.commands.registerCommand(
      'liveTestRunner.rerunFromEditor',
      rerunFromEditor,
    ),
    vscode.commands.registerCommand(
      'liveTestRunner.debugFromEditor',
      debugFromEditor,
    ),
    vscode.commands.registerCommand(
      'liveTestRunner.focusResult',
      focusResult,
    ),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) { decorationManager.applyToEditor(editor); }
    }),

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
  const configured = vscode.workspace
    .getConfiguration('liveTestRunner')
    .get<string>('projectRoot');
  if (configured?.trim()) return configured.trim();
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) return folders[0].uri.fsPath;
  return undefined;
}

function getJestCommand(): string {
  const cfg = vscode.workspace.getConfiguration('liveTestRunner');
  const runMode = cfg.get<string>('runMode') ?? 'auto';
  if (runMode === 'npm') {
    // Delegate to "npm test" — JestRunner will invoke: npm test -- <jest args>
    return 'npm test --';
  }
  return cfg.get<string>('jestCommand') || '';
}

function getTestFileGlob(): vscode.GlobPattern {
  const patterns = vscode.workspace
    .getConfiguration('liveTestRunner')
    .get<string[]>('testFilePatterns') ?? ['**/*.test.*', '**/*.spec.*'];
  return `{${patterns.join(',')}}`;
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
      'Select Project Root',
    );
    if (pick) await selectProjectRoot();
    return;
  }

  if (testSession) {
    testSession.stop();
    testSession = undefined;
  }

  // Focus the Live Test Results panel; keep the output channel for logging only
  vscode.commands.executeCommand('liveTestRunner.results.focus');
  outputChannel.appendLine('');
  outputChannel.appendLine(`[Live Test Runner] Starting — ${projectRoot}`);

  const runner = new JestRunner(getJestCommand(), (msg) =>
    outputChannel.appendLine(msg),
  );
  testSession = new TestSession(runner);

  try {
    updateStatusBar('Discovering…');

    const testFiles = await runner.discoverTests(projectRoot);
    outputChannel.appendLine(
      `[Live Test Runner] Found ${testFiles.length} test file(s)`,
    );

    if (testFiles.length === 0) {
      updateStatusBar('✅ Ready');
      testSession.activate();
      return;
    }

    testSession.activate();
    broadcast({ type: 'session-started' });

    // Register CodeLens for test files while session is active
    codeLensDisposable = vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: getTestFileGlob() },
      codeLensProvider,
    );
    extensionContext.subscriptions.push(codeLensDisposable);

    // Apply decorations to any already-open editors
    for (const editor of vscode.window.visibleTextEditors) {
      decorationManager.applyToEditor(editor);
    }

    await runFiles(testFiles, projectRoot, true);
  } catch (error) {
    updateStatusBar('❌ Error');
    vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
  }
}

function stopTesting() {
  if (testSession) {
    testSession.stop();
    testSession = undefined;
  }
  decorationManager.dispose();
  resultStore.clearAllLineMaps();
  codeLensProvider.refresh();
  codeLensDisposable?.dispose();
  codeLensDisposable = undefined;
  updateStatusBar('Off');
  broadcast({ type: 'session-stopped' });
}

async function selectProjectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('No workspace folders are open.');
    return;
  }

  let selected: string | undefined;
  if (folders.length === 1) {
    selected = folders[0].uri.fsPath;
  } else {
    selected = await vscode.window.showQuickPick(
      folders.map((f: vscode.WorkspaceFolder) => f.uri.fsPath),
      { placeHolder: 'Select project root' },
    );
  }

  if (selected) {
    await vscode.workspace
      .getConfiguration('liveTestRunner')
      .update('projectRoot', selected, vscode.ConfigurationTarget.Workspace);
  }
}

async function rerunScope(args: {
  scope: string;
  fileId: string;
  suiteId?: string;
  testId?: string;
  fullName?: string;
}) {
  const projectRoot = getProjectRoot();
  if (!projectRoot) return;

  // scope test is used for both single test and suite-level reruns; Name is the only thing we can pass to test either suite or test in jest as of 03/04/2026.
  if ((args.scope === 'test' || args.scope === 'suite') && args.fullName) {
    // Run only the specific test case using --testNamePattern
    const runner = new JestRunner(getJestCommand(), (msg) =>
      outputChannel.appendLine(msg),
    );
    runner.setProjectRoot(projectRoot);
    broadcast({
      type: 'files-rerunning',
      fileIds: [args.fileId],
      suiteId: args.suiteId,
      testId: args.testId,
    });
    updateStatusBar('Running… 1/1');
    try {
      const jsonResult = await runner.runTestCaseJson(
        args.fileId,
        args.fullName,
      );
      const fileResult = jsonResult.fileResults[0];
      if (fileResult) {
        applyFileResultToStore(
          args.fileId,
          fileResult,
          args.suiteId,
          args.testId,
        );
      }
    } catch (error) {
      outputChannel.appendLine(
        `[Live Test Runner] Error: ${(error as Error).message}`,
      );
    }
    broadcastFileResult(args.fileId);
    // Refresh the scope panel if the user is looking at this file/test
    const sel = selectionState.get();
    if (sel?.fileId === args.fileId) {
      resultsProvider.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
    }
    updateStatusBar('✅ Ready');
    return;
  }

  await runFiles([args.fileId], projectRoot);
}

// ── On-save ───────────────────────────────────────────────────────────────────
async function onSave(document: vscode.TextDocument) {
  if (!testSession?.isTestingActive()) return;

  const debounceMs =
    vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<number>('onSaveDebounceMs') ?? 300;

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
        const affected = testSession
          .getCoverageMap()
          .getAffectedTests(document.uri.fsPath);
        filesToRun = affected.size > 0 ? Array.from(affected) : [];
        if (filesToRun.length === 0) return;
      }

      await runFiles(filesToRun, projectRoot);
    } catch (error) {
      updateStatusBar('✅ Ready');
      outputChannel.appendLine(
        `[Live Test Runner] Error: ${(error as Error).message}`,
      );
    }
  }, debounceMs);
}

// ── Core run function ─────────────────────────────────────────────────────────
async function runFiles(
  filePaths: string[],
  projectRoot: string,
  isFullSuite = false,
): Promise<void> {
  const CONCURRENCY = 3;
  const queue = [...filePaths];
  let completed = 0;
  let numPassed = 0;
  let numFailed = 0;

  for (const fp of filePaths) {
    const name = vscode.workspace.asRelativePath(fp);
    resultStore.fileStarted(fp, fp, name);
  }

  if (isFullSuite) {
    resultStore.clearAllLineMaps();
    // Wipe the whole results tree for a fresh full run — include pending file list
    // so both the explorer and results panel can pre-populate before tests complete
    broadcast({
      type: 'run-started',
      fileCount: filePaths.length,
      files: (resultStore.toJSON() as { files: unknown[] }).files,
    });
  } else {
    // Partial rerun — keep other files' results, just mark these as running
    broadcast({ type: 'files-rerunning', fileIds: filePaths });
  }
  updateStatusBar(`Running… 0/${filePaths.length}`);

  const totalStart = Date.now();

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, filePaths.length) },
      async () => {
        const poolRunner = new JestRunner(getJestCommand(), (msg) =>
          outputChannel.appendLine(msg),
        );
        poolRunner.setProjectRoot(projectRoot);

        while (true) {
          const filePath = queue.shift();
          if (!filePath) break;

          try {
            const jsonResult = await poolRunner.runTestFileJson(filePath);
            const fileResult = jsonResult.fileResults[0];

            if (fileResult) {
              applyFileResultToStore(filePath, fileResult);
              if (fileResult.status === 'passed') numPassed++;
              else numFailed++;
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
          // Refresh scope panel if user has this file selected
          const sel = selectionState.get();
          if (sel?.fileId === filePath) {
            resultsProvider.sendScopedData(sel.fileId, sel.suiteId, sel.testId);
          }
        }
      },
    ),
  );

  outputChannel.appendLine(
    `[Live Test Runner] Finished in ${Date.now() - totalStart}ms`,
  );

  const summary = resultStore.getSummary();
  broadcast({
    type: 'run-finished',
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    sessionActive: !!testSession?.isTestingActive(),
  });

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
      suites: Array.from(fileData.suites.values()).map((s) => ({
        suiteId: s.suiteId,
        name: s.name,
        status: s.status,
        duration: s.duration,
        tests: Array.from(s.tests.values()).map((t) => ({
          testId: t.testId,
          name: t.name,
          fullName: t.fullName,
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
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function applyFileResultToStore(
  filePath: string,
  fileResult: JestFileResult,
  selectedSuiteId?: string,
  selectedTestId?: string,
): void {
  // Track which suites and tests were touched for scoped output assignment
  const touchedSuiteIds = new Set<string>();
  let touchedTestId: string | undefined;

  for (const tc of fileResult.testCases) {
    const suiteKey = tc.ancestorTitles.join(' > ') || '(root)';
    const suiteId = `${filePath}::${suiteKey}`;

    if (!!selectedSuiteId && suiteId !== selectedSuiteId) continue;

    if (!resultStore.getSuite(filePath, suiteId)) {
      resultStore.suiteStarted(filePath, suiteId, suiteKey);
    }
    touchedSuiteIds.add(suiteId);

    // Use fullName as the stable key — positional counters break single-test reruns
    // because only the rerun test appears in the result, resetting the counter.
    const testId = `${suiteId}::${tc.fullName || tc.title}`;

    if (!!selectedTestId && testId !== selectedTestId) continue;

    resultStore.testStarted(
      filePath,
      suiteId,
      testId,
      tc.title,
      tc.fullName || tc.title,
    );
    touchedTestId = testId;

    const status: TestStatus =
      tc.status === 'passed'
        ? 'passed'
        : tc.status === 'failed'
          ? 'failed'
          : tc.status === 'skipped'
            ? 'skipped'
            : 'pending';

    const cleanMessages = (tc.failureMessages ?? []).map(stripAnsi);
    resultStore.testResult(
      filePath,
      suiteId,
      testId,
      status,
      tc.duration,
      cleanMessages,
    );
  }

  // Roll up suite statuses
  const file = resultStore.getFile(filePath);
  if (file) {
    for (const suite of file.suites.values()) {
      const tests = Array.from(suite.tests.values());
      const suiteStatus: TestStatus = tests.some((t) => t.status === 'failed')
        ? 'failed'
        : 'passed';
      const suiteDur = tests.reduce((acc, t) => acc + (t.duration ?? 0), 0);
      resultStore.suiteResult(filePath, suite.suiteId, suiteStatus, suiteDur);
    }
  }

  // Store console output at the appropriate scope
  const consoleLines = fileResult.consoleOutput?.length
    ? fileResult.consoleOutput
    : [];
  const now = Date.now();

  if (selectedTestId && touchedTestId) {
    // Single-test rerun: store output at test (and its suite) scope
    const suiteId = [...touchedSuiteIds][0];
    if (suiteId) {
      const scopedOutput: ScopedOutput = {
        lines: buildOutputLines(consoleLines, now),
        capturedAt: now,
      };
      resultStore.setSuiteOutput(filePath, suiteId, scopedOutput);
      resultStore.setTestOutput(filePath, suiteId, touchedTestId, scopedOutput);
    }
  } else if (selectedSuiteId && touchedSuiteIds.size > 0) {
    // Suite-level rerun: store output at suite scope
    const suiteId = [...touchedSuiteIds][0];
    if (suiteId) {
      resultStore.setSuiteOutput(filePath, suiteId, {
        lines: buildOutputLines(consoleLines, now),
        capturedAt: now,
      });
    }
  } else {
    // Full file run: store output at file scope only
    resultStore.setFileOutput(filePath, {
      lines: buildOutputLines(consoleLines, now),
      capturedAt: now,
    });
  }

  resultStore.fileResult(
    filePath,
    fileResult.status === 'passed' ? 'passed' : 'failed',
    fileResult.duration,
  );

  // ── Populate LineMap from location data ──────────────────────────────────
  resultStore.clearLineMap(filePath);
  for (const tc of fileResult.testCases) {
    if (tc.location?.line == null) { continue; }
    const suiteKey = tc.ancestorTitles.join(' > ') || '(root)';
    const suiteId  = `${filePath}::${suiteKey}`;
    const testId   = `${suiteId}::${tc.fullName || tc.title}`;
    const lineStatus: LineEntry['status'] =
      tc.status === 'passed' ? 'passed'
      : tc.status === 'failed' ? 'failed'
      : 'pending';
    resultStore.setLineEntry(filePath, tc.location.line, {
      testId,
      suiteId,
      fileId:   filePath,
      status:   lineStatus,
      duration: tc.duration ?? null,
    });
  }

  // Refresh decorations for any visible editor showing this file
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.fsPath === filePath) {
      decorationManager.applyToEditor(editor);
    }
  }
  codeLensProvider.refresh();
}

// ── Editor CodeLens commands ──────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rerunFromEditor(filePath: string, line: number): void {
  const projectRoot = getProjectRoot();
  if (!projectRoot) { return; }
  const entry = resultStore.getLineMap(filePath).get(line);
  if (!entry) {
    runFiles([filePath], projectRoot);
    return;
  }
  const test = resultStore.getTest(entry.fileId, entry.suiteId, entry.testId);
  if (test) {
    rerunScope({
      scope:    'test',
      fileId:   entry.fileId,
      suiteId:  entry.suiteId,
      testId:   entry.testId,
      fullName: test.fullName,
    });
  } else {
    runFiles([filePath], projectRoot);
  }
}

async function debugFromEditor(filePath: string, line: number): Promise<void> {
  const projectRoot = getProjectRoot();
  if (!projectRoot) { return; }
  const entry  = resultStore.getLineMap(filePath).get(line);
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));

  const args: string[] = [filePath];
  if (entry) {
    const test = resultStore.getTest(entry.fileId, entry.suiteId, entry.testId);
    if (test) {
      args.push('--testNamePattern', escapeRegex(test.fullName));
    }
  }
  args.push('--runInBand', '--no-coverage');

  await vscode.debug.startDebugging(folder, {
    type:      'node',
    request:   'launch',
    name:      'Debug Jest test',
    program:   '${workspaceFolder}/node_modules/.bin/jest',
    args,
    cwd:       projectRoot,
    console:   'integratedTerminal',
    skipFiles: ['<node_internals>/**'],
  });
}

function focusResult(fileId: string, suiteId: string, testId: string): void {
  vscode.commands.executeCommand('liveTestRunner.results.focus');
  selectionState.select({ scope: 'test', fileId, suiteId, testId });
  resultsProvider.postMessage({ type: 'scope-changed', scope: 'test', fileId, suiteId, testId });
}

function buildOutputLines(
  entries: JestFileResult['consoleOutput'],
  timestamp: number,
): OutputLine[] {
  return entries.map((entry) => ({
    text: stripAnsi(entry.message),
    level: (entry.type === 'warn'
      ? 'warn'
      : entry.type === 'error'
        ? 'error'
        : entry.type === 'log'
          ? 'log'
          : 'info') as OutputLevel,
    timestamp,
  }));
}
