'use strict';
/**
 * Monorepo (phase 7, D11): every package with tests is a project, none runs
 * on its own; the switcher selects which one the views show and Start / Stop
 * act on; liveTestRunner.maxRunningProjects refuses one more with a message
 * naming the running project; the projectRoot setting pins one root.
 */
const path = require('path');
const h = require('../lib/harness');

const norm = (p) => p.replace(/\\/g, '/');

/** Gutter icons DecorationManager would draw for a document: { 'status-passed': n, … }. */
function gutterCounts(api, doc) {
  const keyOf = new Map([...api.decorationManager._decorations].map(([k, v]) => [v, k]));
  const counts = {};
  api.decorationManager.applyToEditor({
    document: doc,
    setDecorations: (type, ranges) => { if (ranges.length) { counts[keyOf.get(type)] = ranges.length; } },
  });
  return counts;
}

module.exports = {
  workspace: 'fixture:monorepo-jest',
  settings: { 'liveTestRunner.maxRunningProjects': 1 },
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    t.eq('two projects detected (the package without tests is not one)', reg.contexts.map((c) => c.name), ['app-a', 'app-b']);
    t.eq('their roots are the packages', reg.contexts.map((c) => norm(path.relative(workspace, c.root))), ['packages/app-a', 'packages/app-b']);
    t.eq('both are Jest projects', reg.contexts.map((c) => c.framework), ['jest', 'jest']);
    t.eq('none runs automatically', reg.contexts.map((c) => c.session.isActive()), [false, false]);
    t.eq('the first project is selected', reg.selected && reg.selected.name, 'app-a');
    t.check('only the selected project is discovered at activation', reg.contexts[0].discoveryStarted && !reg.contexts[1].discoveryStarted);

    await h.waitForDiscovery(api);
    const files = () => api.store.getAllFiles().map((f) => norm(path.relative(workspace, f.filePath))).sort();
    t.eq('the views show app-a\'s files only', files(), ['packages/app-a/src/broken.test.js', 'packages/app-a/src/sum.test.js']);
    t.check('status bar names the selected project', /^Live Tests: app-a · Off$/.test(api.statusBar.text), api.statusBar.text);
    t.eq('the Explorer switcher gets both projects', api.explorerView._projects.map((p) => [p.name, p.selected]), [['app-a', true], ['app-b', false]]);
    t.check('no Jest process before Start', h.jestProcesses(workspace).length === 0, h.jestProcesses(workspace).join('\n'));

    // ── A file of another (undiscovered) project opened while app-a is shown ─
    const greet = path.join(workspace, 'packages', 'app-b', 'src', 'greet.test.js');
    const greetDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(greet));
    await vscode.window.showTextDocument(greetDoc);
    await h.waitFor(() => reg.contexts[1].discovery.hasCompleted, { what: 'app-b discovery for its open file', timeout: 30_000 });
    t.eq('opening an app-b file discovers app-b (still not selected, not running)', [reg.selected.name, reg.contexts[1].session.isActive()], ['app-a', false]);
    const lenses = api.codeLensProvider.provideCodeLenses(greetDoc).filter((l) => l.command.title === '▶ Run');
    t.eq('CodeLens on the app-b file come from app-b', lenses.length, 3);
    t.eq('gutter on the app-b file: app-b\'s pending tests', gutterCounts(api, greetDoc), { 'status-pending': 3 });
    // An explicit ▶ Run works without a session (§7) and runs in the file's project.
    const seq0 = [reg.contexts[0].session._runSeq, reg.contexts[1].session._runSeq];
    await vscode.commands.executeCommand(lenses[0].command.command, ...lenses[0].command.arguments);
    const ran = reg.contexts[1].store.getFileNodes(reg.contexts[1].store.findFileKey(greet)).find((n) => n.fullName === lenses[0].command.arguments[0].fullName);
    t.eq('▶ Run (no session) ran in app-b, not app-a', [reg.contexts[0].session._runSeq - seq0[0], reg.contexts[1].session._runSeq - seq0[1], ran && ran.status], [0, 1, 'passed']);
    t.check('…and started no session anywhere', !reg.contexts[0].session.isActive() && !reg.contexts[1].session.isActive());
    t.eq('the gutter on the app-b file shows that result', gutterCounts(api, greetDoc), { 'status-passed': 1, 'status-pending': 2 });

    // ── Switch to app-b and run it ─────────────────────────────────────────
    const id = await vscode.commands.executeCommand('liveTestRunner.selectProject', 'app-b');
    t.eq('Select Project switches to app-b', reg.selected.name, 'app-b');
    t.check('the command returns the project id', id === reg.selected.id, String(id));
    await h.waitForDiscovery(api);
    t.eq('the views now show app-b\'s files', files(), ['packages/app-b/src/greet.test.js']);
    t.check('status bar follows the switch', /^Live Tests: app-b · ✅ 1 passed$/.test(api.statusBar.text), api.statusBar.text);

    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning() && api.store.getSummary().passed === 3,
      { what: 'app-b to finish', timeout: 120_000 });
    t.eq('app-b results', h.statusCounts(api, 'greet.test.js'), { passed: 3 });
    t.check('status bar: app-b passed, 1 running', /^Live Tests: app-b · ✅ 3 passed · 1 running$/.test(api.statusBar.text), api.statusBar.text);
    t.eq('switcher row: app-b live with its counts',
      reg.summaries().map((p) => [p.name, p.state, p.passed, p.failed]), [['app-a', 'idle', 0, 0], ['app-b', 'watching', 3, 0]]);

    // ── app-a shown, app-b's file still shows app-b's results ──────────────
    await vscode.commands.executeCommand('liveTestRunner.selectProject', 'app-a');
    t.eq('gutter on the app-b file shows app-b results while app-a is selected', gutterCounts(api, greetDoc), { 'status-passed': 3 });
    const runLens = api.codeLensProvider.provideCodeLenses(greetDoc).find((l) => l.command.title === '▶ Run' && l.command.arguments[0].fullName === 'greets');
    t.check('▶ Run lens for "greets" in the app-b file', !!runLens);
    const seq1 = [reg.contexts[0].session._runSeq, reg.contexts[1].session._runSeq];
    await vscode.commands.executeCommand(runLens.command.command, ...runLens.command.arguments);
    t.eq('▶ Run on the app-b file (app-a selected) runs in app-b', [reg.contexts[0].session._runSeq - seq1[0], reg.contexts[1].session._runSeq - seq1[1], reg.contexts[1].store.getSummary().passed], [0, 1, 3]);
    t.eq('…without touching app-a (still idle, still selected)', [reg.selected.name, reg.contexts[0].session.isActive(), api.store.getAllFiles().every((f) => f.status === 'pending')], ['app-a', false, true]);

    // ── The limit: one running project ─────────────────────────────────────
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const refused = h.logsSince(api, since).filter((l) => /Stop a running project first/.test(l));
    t.check('starting a second project is refused (limit 1)', refused.length === 1, h.logsSince(api, since).join('\n'));
    t.check('the message names the running project', /"app-b" is running/.test(refused[0] || ''), refused[0]);
    t.check('app-a did not start', !reg.contexts[0].session.isActive());
    t.check('app-b keeps running in the background', reg.contexts[1].session.isActive());

    // ── Stop app-b (from the switcher's other project), then app-a may start
    await vscode.commands.executeCommand('liveTestRunner.stopTesting', reg.contexts[1].id);
    t.check('Stop with a project id stops that project', !reg.contexts[1].session.isActive());
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning() && api.store.getSummary().failed === 1,
      { what: 'app-a to finish', timeout: 120_000 });
    t.eq('app-a results: sum.test.js', h.statusCounts(api, 'sum.test.js'), { passed: 2 });
    t.eq('app-a results: broken.test.js', h.statusCounts(api, 'broken.test.js'), { passed: 1, failed: 1 });
    t.eq('app-b\'s results stay in its own store', reg.contexts[1].store.getSummary().passed, 3);
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await h.sleep(2000);
    t.check('no Jest process left after Stop', h.jestProcesses(workspace).length === 0, h.jestProcesses(workspace).join('\n'));

    // ── projectRoot pins the window to one root (the 3.0 behaviour) ────────
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    await cfg.update('projectRoot', path.join(workspace, 'packages', 'app-b'), vscode.ConfigurationTarget.Workspace);
    await h.waitFor(() => reg.contexts.length === 1, { what: 'the pinned project', timeout: 10_000 });
    t.eq('projectRoot: one project, app-b', reg.contexts.map((c) => c.name), ['app-b']);
    t.check('projectRoot: plain status bar (no project name)', /^Live Tests: Off$/.test(api.statusBar.text), api.statusBar.text);
    await cfg.update('projectRoot', undefined, vscode.ConfigurationTarget.Workspace);
    await h.waitFor(() => reg.contexts.length === 2, { what: 'detection again', timeout: 10_000 });
    t.eq('cleared projectRoot: both projects again', reg.contexts.map((c) => c.name), ['app-a', 'app-b']);
  },
};
