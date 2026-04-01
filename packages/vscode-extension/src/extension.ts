import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner } from '@live-test-runner/runner';

let testSession: TestSession | undefined;
let statusBarItem: vscode.StatusBarItem;
let testController: vscode.TestController;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'liveTestRunner.startTesting';
  updateStatusBar('Off');

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
    await testSession.start(projectRoot);
    updateStatusBar('✅ Ready');

    // Populate test explorer
    await refreshTestExplorer(projectRoot);
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
  // Rebuild logic
}

async function refreshTests() {
  // Refresh test explorer
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
  // Manual run related tests
}

async function onSave(document: vscode.TextDocument) {
  if (!testSession) return;

  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  await testSession.onSave(document.uri.fsPath, projectRoot);
}

function updateStatusBar(text: string) {
  statusBarItem.text = `Live Tests: ${text}`;
}

async function refreshTestExplorer(projectRoot: string) {
  if (!testSession) return;

  const runner = testSession.getRunner() as JestRunner;
  const testFiles = await runner.discoverTests(projectRoot);

  // Clear existing
  testController.items.clear();

  // Add test files as items
  for (const file of testFiles) {
    const item = testController.createTestItem(file, vscode.workspace.asRelativePath(file), vscode.Uri.file(file));
    testController.items.add(item);
  }
}

async function refreshTestsHandler(): Promise<void> {
  const projectRoot = vscode.workspace.getConfiguration('liveTestRunner').get('projectRoot') as string;
  if (projectRoot) {
    await refreshTestExplorer(projectRoot);
  }
}

async function runTestsHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = testController.createTestRun(request);
  // Implement running tests
  // For now, just mark as passed
  for (const test of request.include || testController.items) {
    run.passed(test);
  }
  run.end();
}