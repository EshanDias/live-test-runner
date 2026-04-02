import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner, TestResult } from '@live-test-runner/runner';

let testSession: TestSession | undefined;
let statusBarItem: vscode.StatusBarItem;
let testController: vscode.TestController;
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');

  // Create diagnostic collection for test errors
  diagnosticCollection = vscode.languages.createDiagnosticCollection('liveTestRunner');
  context.subscriptions.push(diagnosticCollection);

  // Create output channel for test results
  outputChannel = vscode.window.createOutputChannel('Live Test Runner');
  context.subscriptions.push(outputChannel);

  // Create test controller
  testController = vscode.tests.createTestController('liveTestRunner', 'Live Test Runner');
  testController.refreshHandler = refreshTestsHandler;
  testController.runHandler = runTestsHandler;
  context.subscriptions.push(testController);

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

  // Listen for document saves
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(onSave)
  );

  statusBarItem.show();
}

export function deactivate() {
  if (testSession) {
    testSession.stop();
  }
}

async function startTesting() {
  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  if (!projectRoot) {
    vscode.window.showErrorMessage('Please select a project root first.');
    return;
  }

  updateStatusBar('Starting…');

  const runner = new JestRunner(vscode.workspace.getConfiguration('liveTestRunner').get('jestCommand') as string);
  testSession = new TestSession(runner);

  try {
    const result = await testSession.start(projectRoot);
    if (result.passed) {
      updateStatusBar('✅ Ready');
      // Populate test explorer
      await refreshTestExplorer(projectRoot);
    } else {
      updateStatusBar('❌ Failed');
      vscode.window.showErrorMessage(`Failed to start testing: ${result.errors.join(', ')}`);
    }
  } catch (error) {
    updateStatusBar('❌ Failed');
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
  if (!testSession) {
    vscode.window.showErrorMessage('Testing not started.');
    return;
  }

  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  if (!projectRoot) return;

  try {
    updateStatusBar('Rebuilding…');
    const runner = testSession.getRunner();

    // Run full suite with coverage
    const result = await runner.runFullSuite(projectRoot, true);

    if (result.passed) {
      // Rebuild the map
      const coverageMap = testSession.getCoverageMap();
      coverageMap.clear();
      coverageMap.buildFromCoverage(await runner.getCoverage());

      updateStatusBar('✅ Ready');
      vscode.window.showInformationMessage('Test map rebuilt successfully');
    } else {
      updateStatusBar('❌ Error');
      vscode.window.showErrorMessage(`Failed to rebuild map: ${result.errors.join(', ')}`);
      updateStatusBar('✅ Ready');
    }
  } catch (error) {
    updateStatusBar('❌ Error');
    vscode.window.showErrorMessage(`Failed to rebuild map: ${error}`);
    updateStatusBar('✅ Ready');
  }
}

async function refreshTests() {
  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  if (!projectRoot) {
    vscode.window.showErrorMessage('Please select a project root first.');
    return;
  }

  if (!testSession) {
    vscode.window.showErrorMessage('Testing not started.');
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
  if (!folders) return;

  const selected = await vscode.window.showQuickPick(
    folders.map(f => f.uri.fsPath),
    { placeHolder: 'Select project root' }
  );

  if (selected) {
    await vscode.workspace.getConfiguration('liveTestRunner').update('projectRoot', selected, vscode.ConfigurationTarget.Workspace);
  }
}

async function runRelatedTests() {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    vscode.window.showErrorMessage('No active file');
    return;
  }

  if (!testSession) {
    vscode.window.showErrorMessage('Testing not started.');
    return;
  }

  try {
    updateStatusBar('Running…');
    const runner = testSession.getRunner();
    const result = await runner.runRelatedTests(activeEditor.document.uri.fsPath);
    if (result.passed) {
      updateStatusBar('✅ Ready');
      vscode.window.showInformationMessage('Related tests executed');
    } else {
      updateStatusBar('❌ Failed');
      vscode.window.showErrorMessage(`Related tests failed: ${result.errors.join(', ')}`);
      updateStatusBar('✅ Ready');
    }
  } catch (error) {
    updateStatusBar('❌ Error');
    vscode.window.showErrorMessage(`Failed to run related tests: ${error}`);
    updateStatusBar('✅ Ready');
  }
}

function clearDiagnostics() {
  diagnosticCollection.clear();
  vscode.window.showInformationMessage('Test diagnostics cleared');
}

function showOutput() {
  outputChannel.show();
}

async function onSave(document: vscode.TextDocument) {
  if (!testSession) return;

  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get('onSaveDebounceMs') as number;

  // Debounce on-save execution
  setTimeout(async () => {
    try {
      updateStatusBar('Running…');
      outputChannel.appendLine(`[Live Test Runner] Running tests for: ${vscode.workspace.asRelativePath(document.uri)}`);
      const result = await testSession!.onSave(document.uri.fsPath, projectRoot);
      outputChannel.appendLine(result.output);
      if (result.passed) {
        outputChannel.appendLine(`[Live Test Runner] Tests passed ✅`);
        updateStatusBar('✅ Ready');
      } else {
        outputChannel.appendLine(`[Live Test Runner] Tests failed ❌`);
        outputChannel.appendLine(`Errors: ${result.errors.join(', ')}`);
        updateStatusBar('❌ Failed');
        vscode.window.showErrorMessage(`Tests failed: ${result.errors.join(', ')}`);
        updateStatusBar('✅ Ready');
      }
    } catch (error) {
      outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
      updateStatusBar('❌ Error');
      vscode.window.showErrorMessage(`Test execution failed: ${(error as Error).message}`);
      updateStatusBar('✅ Ready');
    }
  }, debounceMs);
}

function updateStatusBar(text: string) {
  statusBarItem.text = `Live Tests: ${text}`;
}

async function refreshTestExplorer(projectRoot: string) {
  if (!testSession) return;

  const runner = testSession.getRunner() as JestRunner;
  const testFiles = await runner.discoverTests(projectRoot);

  // Replace all items
  testController.items.replace(testFiles.map(file => {
    const relativePath = vscode.workspace.asRelativePath(file);
    return testController.createTestItem(file, relativePath, vscode.Uri.file(file));
  }));
}

async function refreshTestsHandler(): Promise<void> {
  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  if (projectRoot) {
    await refreshTestExplorer(projectRoot);
  }
}

async function runTestsHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = testController.createTestRun(request);
  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;

  if (!testSession || !projectRoot) {
    run.end();
    return;
  }

  const runner = testSession.getRunner();

  // Get all test items to run
  const testsToRun = request.include || Array.from(testController.items).map(([_, item]) => item);

  for (const testItem of testsToRun) {
    if (token.isCancellationRequested) {
      run.end();
      return;
    }

    run.started(testItem);

    try {
      // Run the specific test file
      outputChannel.appendLine(`[Live Test Runner] Running test: ${vscode.workspace.asRelativePath(vscode.Uri.file(testItem.id))}`);
      const result = await runner.runTestFile(testItem.id);
      outputChannel.appendLine(result.output);
      if (result.passed) {
        outputChannel.appendLine(`[Live Test Runner] Test passed ✅`);
        run.passed(testItem);
      } else {
        outputChannel.appendLine(`[Live Test Runner] Test failed ❌`);
        outputChannel.appendLine(`Errors: ${result.errors.join(', ')}`);
        run.failed(testItem, new vscode.TestMessage(result.errors.join('\n')), 0);
      }
      // Append output to the test run
      run.appendOutput(result.output);
    } catch (error) {
      outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
      run.failed(testItem, new vscode.TestMessage((error as Error).message), 0);
    }
  }

  run.end();
}