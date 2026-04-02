import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';

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

  outputChannel = vscode.window.createOutputChannel('Live Test Runner');
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

  statusBarItem.show();

  const initialRoot = getEffectiveProjectRoot();
  if (initialRoot) {
    refreshTestExplorer(initialRoot).catch(() => {});
  }
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
  outputChannel.appendLine(`[Live Test Runner] ${msg}`);
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

  outputChannel.show(true);
  outputChannel.appendLine('');
  log('── Starting ──────────────────────────────────────────');
  log(`Project root : ${projectRoot}`);
  log(`Jest command : ${getJestCommand() || '(auto-detect)'}`);

  const logger = (msg: string) => outputChannel.appendLine(msg);
  const runner = new JestRunner(getJestCommand(), logger);
  testSession = new TestSession(runner);

  try {
    // Step 1 — discover test files
    updateStatusBar('Discovering…');
    log('Discovering tests…');
    const testFiles = await runner.discoverTests(projectRoot);
    log(`Found ${testFiles.length} test file(s)`);
    await refreshTestExplorer(projectRoot);

    // Step 2 — warmup: full suite run with coverage + JSON results
    updateStatusBar('Running…');
    log('Running warmup suite…');
    const jsonResult = await runner.runFullSuiteJson(projectRoot, true);

    // Step 3 — build coverage map
    const coverageData = await runner.getCoverage();
    testSession.getCoverageMap().buildFromCoverage(coverageData);
    testSession.activate();

    // Step 4 — update status bar with pass/fail counts
    if (jsonResult.passed) {
      updateStatusBar(`✅ ${jsonResult.numPassedTests} passed`);
      log(`Warmup complete — ${jsonResult.numPassedTests} passed ✅`);
    } else {
      updateStatusBar(`❌ ${jsonResult.numFailedTests} failed`);
      log(`Warmup complete — ${jsonResult.numFailedTests} failed ❌`);
      if (vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('showOutputOnFailure')) {
        outputChannel.show(true);
      }
    }

    // Step 5 — populate sidebar with warmup results
    if (jsonResult.fileResults.length > 0) {
      const warmupRun = testController.createTestRun(new vscode.TestRunRequest(), 'Warmup', false);
      try {
        for (const fileResult of jsonResult.fileResults) {
          const fileItem = findOrCreateFileItem(fileResult.testFilePath);
          if (!fileItem) continue;
          warmupRun.started(fileItem);
          applyFileResult(warmupRun, fileItem, fileResult);
        }
      } finally {
        warmupRun.end();
      }
    }

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
  if (!testSession) return;
  const projectRoot = getEffectiveProjectRoot();
  if (!projectRoot) return;

  const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get<number>('onSaveDebounceMs') ?? 300;

  setTimeout(async () => {
    try {
      updateStatusBar('Running…');
      log(`\nRunning tests for: ${vscode.workspace.asRelativePath(document.uri)}`);
      const result = await testSession!.onSave(document.uri.fsPath, projectRoot);
      if (result.passed) {
        updateStatusBar('✅ Ready');
        log('✅ Passed');
      } else {
        updateStatusBar('✅ Ready');
        if (vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('showOutputOnFailure')) {
          outputChannel.show(true);
        }
      }
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

  try {
    const projectRoot = getEffectiveProjectRoot();
    if (!projectRoot) return;

    const logger = (msg: string) => {
      outputChannel.appendLine(msg);
      run.appendOutput(msg.replace(/\r?\n/g, '\r\n') + '\r\n');
    };

    const runner: JestRunner = testSession
      ? (testSession.getRunner() as JestRunner)
      : new JestRunner(getJestCommand(), logger);

    if (!testSession) {
      try { await runner.discoverTests(projectRoot); } catch { /* projectRoot set via fallback */ }
    }

    const testsToRun = request.include
      ?? Array.from(testController.items as Iterable<[string, vscode.TestItem]>).map(([_id, item]) => item);

    for (const fileItem of testsToRun) {
      if (token.isCancellationRequested) { run.skipped(fileItem); continue; }

      run.started(fileItem);
      updateStatusBar('Running…');
      log(`\nRunning: ${vscode.workspace.asRelativePath(fileItem.uri!)}`);

      try {
        const jsonResult = await runner.runTestFileJson(fileItem.id);

        // Clear and rebuild children for this file based on actual results
        fileItem.children.replace([]);

        if (jsonResult.fileResults.length > 0) {
          applyFileResult(run, fileItem, jsonResult.fileResults[0]);
        } else {
          // No file results (e.g. compile error before Jest could list tests)
          const msg = jsonResult.errors.join('\n') || 'No test results returned';
          run.errored(fileItem, new vscode.TestMessage(msg));
        }
      } catch (error) {
        run.errored(fileItem, new vscode.TestMessage((error as Error).message));
      }
    }

    // Update status bar with final state
    const allItems = request.include
      ?? Array.from(testController.items as Iterable<[string, vscode.TestItem]>).map(([_id, item]) => item);
    if (testSession?.isTestingActive()) {
      updateStatusBar('✅ Ready');
    } else if (allItems.length > 0) {
      updateStatusBar('✅ Ready');
    }

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
