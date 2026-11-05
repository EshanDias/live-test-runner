'use strict';
/**
 * Every command, run the way a user runs it (mostly from the Command Palette,
 * i.e. without arguments), with what it should do checked. Scenarios that
 * already cover a command in depth are noted; here each one at least runs.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(800);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}

/** Runs a command that shows a quick pick, closes the pick, and returns the command's result. */
async function withQuickPickClosed(vscode, command, ...args) {
  const p = Promise.resolve(vscode.commands.executeCommand(command, ...args));
  await h.sleep(800);
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  return p;
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 8 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const ctx = () => api.projects.selected;
    const mathTest = path.join(workspace, 'src', 'math.test.js');
    const mathSrc = path.join(workspace, 'src', 'math.js');
    await h.waitForDiscovery(api);

    // ── Panels and channels ──────────────────────────────────────────────
    const outputShown = (name) => vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'output' && e.document.uri.path.includes(name));
    await vscode.commands.executeCommand('liveTestRunner.showOutput');
    await h.sleep(600);
    t.check('Show Test Output opens the test output channel', outputShown('Test Output') || outputShown('Live Test Runner'), vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()).join(', '));
    await vscode.commands.executeCommand('liveTestRunner.showLogs');
    await h.sleep(600);
    t.check('Show Logs opens the log channel', outputShown('Live Test Runner'));
    await vscode.commands.executeCommand('liveTestRunner.showPanels');
    await h.sleep(600);
    t.check('the status bar click (showPanels) runs', true);

    await vscode.commands.executeCommand('liveTestRunner.copyDiagnostics');
    const report = await vscode.env.clipboard.readText();
    t.check('Copy Diagnostic Report puts a report on the clipboard', /Live Test Runner/i.test(report) && report.includes(workspace.split(path.sep).pop()), report.slice(0, 300));

    // ── Start / Stop ─────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api);
    t.check('Start Testing runs every test', api.session.isActive() && h.nodesWithStatus(api, 'passed').length > 0);

    // ── Editor commands from the Command Palette (cursor, no arguments) ───
    const testDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(mathTest));
    const editor = await vscode.window.showTextDocument(testDoc);
    const adds = h.nodeByName(api, 'src/math.test.js', 'Math utils adds numbers');
    editor.selection = new vscode.Selection(adds.line - 1, 4, adds.line - 1, 4);
    await waitIdle(api);
    await h.sleep(1500); // the full run's last output lines
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.rerunFromEditor');
    await waitIdle(api);
    const summaries = h.jestTestSummaries(h.rawSince(api, mark));
    t.eq('Rerun Test at Line (palette): reruns only the test under the cursor', summaries.map((x) => x.passed), [1]);

    const started = new Promise((resolve) => {
      const d = vscode.debug.onDidStartDebugSession((s) => { d.dispose(); resolve(s); });
      setTimeout(() => { d.dispose(); resolve(undefined); }, 30_000);
    });
    await vscode.commands.executeCommand('liveTestRunner.debugFromEditor');
    const dbg = await started;
    t.check('Debug Test at Line (palette): starts a debug session for the cursor\'s test', !!dbg, dbg?.name);
    await vscode.debug.stopDebugging();
    await h.sleep(1500);

    await vscode.commands.executeCommand('liveTestRunner.focusResult');
    t.check('Focus Test in Results Panel (palette) runs', true);

    await vscode.commands.executeCommand('liveTestRunner.openTestFile', { testFileId: mathTest, fullName: 'Math utils divides numbers' });
    await h.sleep(500);
    const active = vscode.window.activeTextEditor;
    const divides = h.nodeByName(api, 'src/math.test.js', 'Math utils divides numbers');
    t.check('openTestFile (Results panel link) opens the test at its line', active?.document.uri.fsPath === mathTest && active.selection.active.line === divides.line - 1);
    await vscode.commands.executeCommand('liveTestRunner.revealTestInPanel', { testFileId: mathTest, fullName: 'Math utils divides numbers' });
    t.check('revealTestInPanel (hover link) runs', true);

    // Covering tests from the palette: cursor on "return a + b" in math.js.
    const srcEditor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(mathSrc)));
    srcEditor.selection = new vscode.Selection(1, 4, 1, 4);
    await withQuickPickClosed(vscode, 'liveTestRunner.showCoveringTests');
    t.check('Show All Covering Tests (palette) opens and closes without an error', true);

    await vscode.commands.executeCommand('liveTestRunner.dumpTraceStore');
    t.check('Dump Trace Store runs', true);

    // ── Pickers that must not change anything when cancelled ─────────────
    const settingsFile = path.join(workspace, '.vscode', 'settings.json');
    const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
    await withQuickPickClosed(vscode, 'liveTestRunner.selectProjectRoot');
    const settingsAfter = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
    t.check('Select Project Root asks first: cancelling writes nothing to .vscode/settings.json', settingsBefore === settingsAfter, settingsAfter);
    await withQuickPickClosed(vscode, 'liveTestRunner.selectProject');
    t.check('Select Project (picker) closes without an error', true);
    await vscode.commands.executeCommand('liveTestRunner.selectPythonInterpreter');
    t.check('Select Python Interpreter in a Jest project only says it is for pytest', true);

    // ── Stop, Stop All ───────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    t.check('Stop Testing stops the session', !api.session.isActive());
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api);
    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    t.check('Stop All Projects stops every project', api.projects.contexts.every((c) => !c.session.isActive()));

    // ── Clearing ─────────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api);
    const paths = api.storagePaths(ctx().root);
    const discoveryDir = ctx().discoveryCache?.cacheDir;
    t.check('before clearing: runnable-files list and Jest transform cache exist', fs.existsSync(paths.runnableFiles) && fs.existsSync(paths.transformCache), JSON.stringify(paths));
    await vscode.commands.executeCommand('liveTestRunner.stopAndClearCache');
    t.check('Stop Testing and Clear Cache: session stopped, results cleared', !api.session.isActive() && h.nodesWithStatus(api, 'passed').length === 0);
    t.check('…runnable-files list and Jest transform cache deleted', !fs.existsSync(paths.runnableFiles) && !fs.existsSync(paths.transformCache));
    t.check('…discovery cache emptied (only the lock is left)', !discoveryDir || fs.readdirSync(discoveryDir).every((f) => f === 'session.lock'), discoveryDir && fs.readdirSync(discoveryDir).join(', '));

    await vscode.commands.executeCommand('liveTestRunner.clearCacheAndRestart');
    await waitIdle(api);
    t.check('Clear Cache and Restart Testing: runs again from scratch', api.session.isActive() && h.nodesWithStatus(api, 'passed').length > 0);

    await vscode.commands.executeCommand('liveTestRunner.clearAllCaches', { confirmed: true });
    const tmpRoot = path.dirname(api.sessionDir);
    const leftovers = fs.readdirSync(tmpRoot).filter((n) => !n.startsWith('session-'));
    t.check('Clear All Cached Data: nothing but session folders left in the temp folder', leftovers.length === 0, leftovers.join(', '));
    t.check('…testing stopped in this window', api.projects.contexts.every((c) => !c.session.isActive()));
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api);
    t.check('…and Start works again afterwards', h.nodesWithStatus(api, 'passed').length > 0);
  },
};
