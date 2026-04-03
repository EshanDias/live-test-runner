import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';

// ANSI colour helpers — used only in run.appendOutput() (Test Results panel).
// The Output Channel gets plain text via stripAnsi().
const C = {
  reset:  '\u001b[0m',
  bold:   '\u001b[1m',
  green:  '\u001b[92m',
  yellow: '\u001b[33m',
  red:    '\u001b[31m',
  cyan:   '\u001b[36m',
};

/** Strips all ANSI escape sequences — used before writing to the Output Channel. */
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** Cyan "[Live Test Runner]" prefix for the Test Results panel. */
const LTR = `${C.cyan}[Live Test Runner]${C.reset}`;
/** Plain prefix for the Output Channel. */
const LTR_PLAIN = '[Live Test Runner]';

function colorDuration(ms: number): string {
  if (ms >= 10_000) return `${C.red}${C.bold}${ms}ms ⚠${C.reset}`;
  if (ms >= 3_000)  return `${C.yellow}${ms}ms${C.reset}`;
  return `${C.green}${ms}ms${C.reset}`;
}

let testSession: TestSession | undefined;
let statusBarItem: vscode.StatusBarItem;
let testController: vscode.TestController;
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');

  diagnosticCollection = vscode.languages.createDiagnosticCollection('liveTestRunner');
  context.subscriptions.push(diagnosticCollection);

  // 'ansi' tells VS Code to render ANSI escape sequences as colours (requires VS Code ≥ 1.69)
  outputChannel = vscode.window.createOutputChannel('Live Test Runner (ANSI)', 'ansi');
  context.subscriptions.push(outputChannel);

  testController = vscode.tests.createTestController('liveTestRunner', 'Live Test Runner');
  testController.refreshHandler = (_token: vscode.CancellationToken) => refreshTestsHandler();
  context.subscriptions.push(testController);
  context.subscriptions.push(
    testController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('liveTestRunner.startTesting', startTesting),
    vscode.commands.registerCommand('liveTestRunner.stopTesting', stopTesting),
    vscode.commands.registerCommand('liveTestRunner.rebuildMap', rebuildMap),
    vscode.commands.registerCommand('liveTestRunner.refreshTests', refreshTests),
    vscode.commands.registerCommand('liveTestRunner.selectProjectRoot', selectProjectRoot),
    vscode.commands.registerCommand('liveTestRunner.runRelatedTests', runRelatedTests),
    vscode.commands.registerCommand('liveTestRunner.clearDiagnostics', clearDiagnostics),
    vscode.commands.registerCommand('liveTestRunner.showOutput', showOutput),
    statusBarItem
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(onSave)
  );

  // Clear session when workspace changes to prevent cross-window cache issues
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (testSession) {
        testSession.stop();
        testSession = undefined;
        updateStatusBar('Off');
        testController.items.replace([]);
        diagnosticCollection.clear();
        outputChannel.clear();
      }
    })
  );

  statusBarItem.show();
}

export function deactivate() {
  if (testSession) testSession.stop();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEffectiveProjectRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot');
  if (configured?.trim()) return configured.trim();
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length === 1) return folders[0].uri.fsPath;
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

// ── Commands ─────────────────────────────────────────────────────────────────

async function startTesting() {
  const projectRoot = getEffectiveProjectRoot();
  if (!projectRoot) {
    const pick = await vscode.window.showErrorMessage(
      'No project root found. Open a single folder or configure liveTestRunner.projectRoot.',
      'Select Project Root'
    );
    if (pick) await selectProjectRoot();
    return;
  }

  // Stop any previous session cleanly
  if (testSession) { testSession.stop(); testSession = undefined; }

  outputChannel.show(true);
  outputChannel.appendLine('');
  log('── Starting ──────────────────────────────────────────');
  log(`Project root : ${projectRoot}`);
  log(`Jest command : ${getJestCommand() || '(auto-detect)'}`);

  const runner = new JestRunner(getJestCommand(), (msg) => outputChannel.appendLine(msg));
  testSession = new TestSession(runner);

  try {
    updateStatusBar('Discovering…');
    log('Discovering tests…');

    // refreshTestExplorer calls runner.discoverTests which sets projectRoot on the runner
    await refreshTestExplorer(projectRoot);

    const allItems = Array.from(
      testController.items as Iterable<[string, vscode.TestItem]>
    ).map(([_id, item]) => item);

    log(`Found ${allItems.length} test file(s)`);

    if (allItems.length === 0) {
      log('No test files found.');
      updateStatusBar('✅ Ready');
      testSession.activate();
      return;
    }

    // Activate the session so on-save triggers work immediately
    testSession.activate();

    // Run all tests through the same shared handler — same as on-save and manual sidebar runs
    await runTestsHandler(
      new vscode.TestRunRequest(allItems),
      new vscode.CancellationTokenSource().token
    );

  } catch (error) {
    updateStatusBar('❌ Error');
    log(`Error: ${error}`);
    vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
  }
}

function stopTesting() {
  if (testSession) {
    testSession.stop();
    testSession = undefined;
  }
  updateStatusBar('Off');
}

async function rebuildMap() {
  if (!testSession) { vscode.window.showErrorMessage('Testing not started.'); return; }
  const projectRoot = getEffectiveProjectRoot();
  if (!projectRoot) return;

  try {
    updateStatusBar('Rebuilding…');
    const runner = testSession.getRunner();
    const result = await runner.runFullSuite(projectRoot, true);
    if (result.passed) {
      const coverageMap = testSession.getCoverageMap();
      coverageMap.clear();
      coverageMap.buildFromCoverage(await runner.getCoverage());
      updateStatusBar('✅ Ready');
      vscode.window.showInformationMessage('Test map rebuilt successfully');
    } else {
      updateStatusBar('✅ Ready');
      vscode.window.showErrorMessage(`Failed to rebuild map: ${result.errors.join(', ')}`);
    }
  } catch (error) {
    updateStatusBar('✅ Ready');
    vscode.window.showErrorMessage(`Failed to rebuild map: ${error}`);
  }
}

async function refreshTests() {
  const projectRoot = getEffectiveProjectRoot();
  if (!projectRoot) {
    vscode.window.showErrorMessage('No project root configured.');
    return;
  }
  try {
    await refreshTestExplorer(projectRoot);
    vscode.window.showInformationMessage('Tests refreshed');
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to refresh tests: ${error}`);
  }
}

async function selectProjectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No workspace folders are open.');
    return;
  }

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
    await refreshTestExplorer(selected);
  }
}

async function runRelatedTests() {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) { vscode.window.showErrorMessage('No active file'); return; }
  if (!testSession) { vscode.window.showErrorMessage('Testing not started.'); return; }

  try {
    updateStatusBar('Running…');
    const result = await testSession.getRunner().runRelatedTests(activeEditor.document.uri.fsPath);
    updateStatusBar(result.passed ? '✅ Ready' : '✅ Ready');
    if (!result.passed && vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('showOutputOnFailure')) {
      outputChannel.show(true);
    }
  } catch (error) {
    updateStatusBar('✅ Ready');
    vscode.window.showErrorMessage(`Failed to run related tests: ${error}`);
  }
}

function clearDiagnostics() { diagnosticCollection.clear(); }
function showOutput() { outputChannel.show(); }

async function onSave(document: vscode.TextDocument) {
  if (!testSession?.isTestingActive()) return;

  const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get<number>('onSaveDebounceMs') ?? 300;

  setTimeout(async () => {
    if (!testSession) return; // session may have been stopped during the debounce window

    try {
      const runner = testSession.getRunner() as JestRunner;
      let testItems: vscode.TestItem[];

      if (runner.isTestFile(document.uri.fsPath)) {
        // Saved a test file — run just that file
        const item = findOrCreateFileItem(document.uri.fsPath);
        testItems = item ? [item] : [];
      } else {
        // Saved a source file — use coverage map if available, otherwise run everything
        const affected = testSession.getCoverageMap().getAffectedTests(document.uri.fsPath);
        if (affected.size > 0) {
          testItems = Array.from(affected)
            .map(f => findOrCreateFileItem(f))
            .filter((i): i is vscode.TestItem => i !== undefined);
        } else {
          testItems = Array.from(
            testController.items as Iterable<[string, vscode.TestItem]>
          ).map(([_id, item]) => item);
        }
      }

      if (testItems.length === 0) return;

      await runTestsHandler(
        new vscode.TestRunRequest(testItems),
        new vscode.CancellationTokenSource().token
      );

    } catch (error) {
      updateStatusBar('✅ Ready');
      log(`Error: ${(error as Error).message}`);
    }
  }, debounceMs);
}

// ── Test Explorer ─────────────────────────────────────────────────────────────

async function refreshTestExplorer(projectRoot: string) {
  const runner = testSession
    ? (testSession.getRunner() as JestRunner)
    : new JestRunner(getJestCommand());

  try {
    const testFiles = await runner.discoverTests(projectRoot);
    testController.items.replace(
      testFiles.map((file: string) => {
        const relativePath = vscode.workspace.asRelativePath(file);
        return testController.createTestItem(file, relativePath, vscode.Uri.file(file));
      })
    );
  } catch (error) {
    log(`Test discovery error: ${error}`);
  }
}

async function refreshTestsHandler(): Promise<void> {
  const projectRoot = getEffectiveProjectRoot();
  if (projectRoot) await refreshTestExplorer(projectRoot);
}

async function runTestsHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = testController.createTestRun(request);

  // Output channel gets plain text; Test Results panel gets ANSI colours.
  const logger = (msg: string) => {
    outputChannel.appendLine(stripAnsi(msg));
    run.appendOutput(msg.replace(/\r?\n/g, '\r\n') + '\r\n');
  };

  let numPassed = 0;
  let numFailed = 0;

  try {
    const projectRoot = getEffectiveProjectRoot();
    if (!projectRoot) return;

    const testsToRun = request.include
      ?? Array.from(testController.items as Iterable<[string, vscode.TestItem]>).map(([_id, item]) => item);

    if (token.isCancellationRequested) {
      testsToRun.forEach(item => run.skipped(item));
      return;
    }

    // Mark every file as running upfront — sidebar shows spinners for all files immediately
    for (const item of testsToRun) {
      run.started(item);
    }

    const totalStart = Date.now();
    logger(`${LTR} Running ${testsToRun.length} test file(s)…`);
    updateStatusBar(`Running… 0/${testsToRun.length}`);

    // Concurrency pool — 5 Jest processes running at the same time.
    // Each slot pulls the next file off the queue and resolves results immediately,
    // so the sidebar updates one file at a time as each finishes rather than in bulk.
    const CONCURRENCY = 3;
    const queue = [...testsToRun];
    let completed = 0;

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, testsToRun.length) }, async () => {
        // Each pool slot gets its own JestRunner so processes don't clobber each other
        const poolRunner = new JestRunner(getJestCommand(), logger);
        poolRunner.setProjectRoot(projectRoot);

        while (true) {
          if (token.isCancellationRequested) break;

          // queue.shift() is safe — JS is single-threaded, no race condition
          const fileItem = queue.shift();
          if (!fileItem) break;

          const relPath = vscode.workspace.asRelativePath(fileItem.uri!);

          try {
            const jsonResult = await poolRunner.runTestFileJson(fileItem.id);
            fileItem.children.replace([]);

            // Each runTestFileJson call targets exactly one file, so fileResults[0] is always
            // the result for this file — no path matching needed (which breaks on Windows due
            // to Jest normalising paths differently from VS Code).
            const fileResult = jsonResult.fileResults[0];

            if (fileResult) {
              applyFileResult(run, fileItem, fileResult);
              const statusTag = fileResult.status === 'passed'
                ? `${C.green}${C.bold}PASS${C.reset}`
                : `${C.red}${C.bold}FAIL${C.reset}`;
              const dur = fileResult.duration;
              const durationStr = dur != null && dur > 0 ? ` ${colorDuration(dur)}` : '';
              logger(`${LTR} ${statusTag} ${relPath}${durationStr}`);
              if (fileResult.status === 'passed') { numPassed++; } else { numFailed++; }
            } else {
              const msg = jsonResult.errors.join('\n') || 'No results returned for this file';
              run.errored(fileItem, new vscode.TestMessage(msg));
              logger(`${LTR} ${C.red}${C.bold}ERROR${C.reset} ${relPath}: ${msg}`);
              numFailed++;
            }
          } catch (error) {
            run.errored(fileItem, new vscode.TestMessage((error as Error).message));
            logger(`${LTR} ${C.red}ERROR${C.reset} ${relPath}: ${(error as Error).message}`);
            numFailed++;
          }

          completed++;
          updateStatusBar(`Running… ${completed}/${testsToRun.length}`);
        }
      })
    );

    // Skip anything left if cancelled mid-run
    queue.forEach(item => run.skipped(item));

    logger(`${LTR} Finished in ${colorDuration(Date.now() - totalStart)}`);

    if (numFailed > 0) {
      updateStatusBar(`❌ ${numFailed} failed, ${numPassed} passed`);
    } else if (numPassed > 0) {
      updateStatusBar(`✅ ${numPassed} passed`);
    }

    vscode.commands.executeCommand('testing.showMostRecentOutput');

  } finally {
    run.end();
  }
}

// ── Helpers for populating TestRun from Jest JSON results ─────────────────────

/**
 * Applies a single JestFileResult to a file-level TestItem, creating
 * suite and test-case children and marking each as passed/failed/skipped.
 */
function applyFileResult(run: vscode.TestRun, fileItem: vscode.TestItem, fileResult: JestFileResult) {
  // File-level compile/parse error — no individual test cases available
  if (fileResult.testCases.length === 0 && fileResult.failureMessage) {
    run.failed(fileItem, new vscode.TestMessage(fileResult.failureMessage));
    return;
  }

  const suiteItems = new Map<string, vscode.TestItem>();

  for (const tc of fileResult.testCases) {
    // Build the suite hierarchy (describe blocks)
    let parent: vscode.TestItem = fileItem;
    for (let depth = 0; depth < tc.ancestorTitles.length; depth++) {
      const suiteId = `${fileItem.id}::${tc.ancestorTitles.slice(0, depth + 1).join('::')}`;
      if (!suiteItems.has(suiteId)) {
        const suiteItem = testController.createTestItem(
          suiteId,
          tc.ancestorTitles[depth],
          fileItem.uri
        );
        parent.children.add(suiteItem);
        suiteItems.set(suiteId, suiteItem);
      }
      parent = suiteItems.get(suiteId)!;
    }

    // Create the leaf test-case item
    const testId = `${fileItem.id}::${tc.fullName || [...tc.ancestorTitles, tc.title].join(' > ')}`;
    const testItem = testController.createTestItem(testId, tc.title, fileItem.uri);
    parent.children.add(testItem);

    run.started(testItem);
    if (tc.status === 'passed') {
      run.passed(testItem, tc.duration);
    } else if (tc.status === 'failed') {
      const messages = tc.failureMessages.map((m: string) => new vscode.TestMessage(m));
      run.failed(testItem, messages.length > 0 ? messages : [new vscode.TestMessage('Test failed')], tc.duration);
    } else {
      run.skipped(testItem);
    }
  }

  // Mark the file item itself
  if (fileResult.status === 'passed') {
    run.passed(fileItem);
  } else {
    const failures = fileResult.testCases
      .filter((tc) => tc.status === 'failed')
      .flatMap((tc) => tc.failureMessages.map((m: string) => new vscode.TestMessage(m)));
    run.failed(fileItem, failures.length > 0 ? failures : [new vscode.TestMessage('One or more tests failed')]);
  }
}

/** Finds an existing top-level file TestItem by path, or creates a new one. */
function findOrCreateFileItem(filePath: string): vscode.TestItem | undefined {
  const existing = testController.items.get(filePath);
  if (existing) return existing;

  // File might not be in the controller yet (e.g. a new file found during warmup)
  const relativePath = vscode.workspace.asRelativePath(filePath);
  const item = testController.createTestItem(filePath, relativePath, vscode.Uri.file(filePath));
  testController.items.add(item);
  return item;
}
