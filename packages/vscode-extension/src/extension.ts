import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner } from '@live-test-runner/runner';

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

  // Auto-discover tests on startup so the Test Explorer is populated immediately
  const initialRoot = getEffectiveProjectRoot();
  if (initialRoot) {
    refreshTestExplorer(initialRoot).catch(() => {
      // Silently ignore — workspace may not have Jest set up yet
    });
  }
}

export function deactivate() {
  if (testSession) {
    testSession.stop();
  }
}

/**
 * Returns the project root to use:
 *  1. The explicitly configured liveTestRunner.projectRoot setting, if set.
 *  2. The single workspace folder, if there is exactly one open.
 *  3. undefined — caller must prompt the user.
 */
function getEffectiveProjectRoot(): string | undefined {
  const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot');
  if (configured?.trim()) return configured.trim();

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length === 1) return folders[0].uri.fsPath;

  return undefined;
}

function getJestCommand(): string {
  return vscode.workspace.getConfiguration('liveTestRunner').get<string>('jestCommand') || 'npx jest';
}

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

  updateStatusBar('Starting…');

  // Show the output panel immediately so the user can follow progress
  outputChannel.show(true);
  outputChannel.appendLine('');
  outputChannel.appendLine(`[Live Test Runner] ── Starting ──────────────────────────`);
  outputChannel.appendLine(`[Live Test Runner] Project root : ${projectRoot}`);
  outputChannel.appendLine(`[Live Test Runner] Jest command : ${getJestCommand() || '(auto-detect)'}`);

  const logger = (msg: string) => outputChannel.appendLine(`[Live Test Runner] ${msg}`);
  const runner = new JestRunner(getJestCommand(), logger);
  testSession = new TestSession(runner);

  try {
    outputChannel.appendLine(`[Live Test Runner] Discovering tests…`);
    // discoverTests is called inside testSession.start — log before the warmup
    const result = await testSession.start(projectRoot);
    outputChannel.appendLine(`[Live Test Runner] Warmup run complete — ${result.passed ? 'passed ✅' : 'failed ❌'}`);

    if (result.passed) {
      updateStatusBar('✅ Ready');
      await refreshTestExplorer(projectRoot);
    } else {
      updateStatusBar('❌ Failed');
      outputChannel.appendLine(result.output);
      vscode.window.showErrorMessage(`Tests failed on warm-up. See output for details.`);
    }
  } catch (error) {
    updateStatusBar('❌ Failed');
    outputChannel.appendLine(`[Live Test Runner] Error: ${error}`);
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
      outputChannel.appendLine(result.output);
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
    vscode.window.showErrorMessage('No project root configured. Open a folder or set liveTestRunner.projectRoot.');
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
      'projectRoot',
      selected,
      vscode.ConfigurationTarget.Workspace
    );
    // Populate the Test Explorer right after selection
    await refreshTestExplorer(selected);
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
    outputChannel.appendLine(result.output);
    if (result.passed) {
      updateStatusBar('✅ Ready');
    } else {
      updateStatusBar('✅ Ready');
      if (vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('showOutputOnFailure')) {
        outputChannel.show(true);
      }
      vscode.window.showErrorMessage(`Related tests failed. See output for details.`);
    }
  } catch (error) {
    updateStatusBar('✅ Ready');
    vscode.window.showErrorMessage(`Failed to run related tests: ${error}`);
  }
}

function clearDiagnostics() {
  diagnosticCollection.clear();
}

function showOutput() {
  outputChannel.show();
}

async function onSave(document: vscode.TextDocument) {
  if (!testSession) return;

  const projectRoot = getEffectiveProjectRoot();
  if (!projectRoot) return;

  const debounceMs = vscode.workspace.getConfiguration('liveTestRunner').get<number>('onSaveDebounceMs') ?? 300;

  setTimeout(async () => {
    try {
      updateStatusBar('Running…');
      outputChannel.appendLine(`\n[Live Test Runner] Running tests for: ${vscode.workspace.asRelativePath(document.uri)}`);
      const result = await testSession!.onSave(document.uri.fsPath, projectRoot);
      outputChannel.appendLine(result.output);
      if (result.passed) {
        outputChannel.appendLine('[Live Test Runner] ✅ Passed');
        updateStatusBar('✅ Ready');
      } else {
        outputChannel.appendLine('[Live Test Runner] ❌ Failed');
        updateStatusBar('✅ Ready');
        if (vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('showOutputOnFailure')) {
          outputChannel.show(true);
        }
      }
    } catch (error) {
      outputChannel.appendLine(`[Live Test Runner] Error: ${(error as Error).message}`);
      updateStatusBar('✅ Ready');
    }
  }, debounceMs);
}

function updateStatusBar(text: string) {
  statusBarItem.text = `Live Tests: ${text}`;
}

/**
 * Populates the Test Explorer tree.
 * Works with or without an active testSession — creates a temporary runner for
 * discovery if no session is running.
 */
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
    outputChannel.appendLine(`[Live Test Runner] Test discovery error: ${error}`);
  }
}

async function refreshTestsHandler(): Promise<void> {
  const projectRoot = getEffectiveProjectRoot();
  if (projectRoot) {
    await refreshTestExplorer(projectRoot);
  }
}

async function runTestsHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
  const run = testController.createTestRun(request);
  const projectRoot = getEffectiveProjectRoot();

  if (!projectRoot) {
    run.end();
    return;
  }

  // Use active session runner if available, otherwise create a temporary one
  const runner: JestRunner = testSession
    ? (testSession.getRunner() as JestRunner)
    : new JestRunner(getJestCommand());

  // Ensure runner knows the project root (needed when no session is active)
  if (!testSession) {
    await runner.discoverTests(projectRoot);
  }

  const testsToRun = request.include ?? Array.from(testController.items as Iterable<[string, vscode.TestItem]>).map(([_id, item]) => item);

  for (const testItem of testsToRun) {
    if (token.isCancellationRequested) break;

    run.started(testItem);

    try {
      const result = await runner.runTestFile(testItem.id);
      run.appendOutput(result.output.replace(/\r?\n/g, '\r\n'));
      if (result.passed) {
        run.passed(testItem);
      } else {
        run.failed(testItem, new vscode.TestMessage(result.errors.join('\n')));
      }
    } catch (error) {
      run.failed(testItem, new vscode.TestMessage((error as Error).message));
    }
  }

  run.end();
}
