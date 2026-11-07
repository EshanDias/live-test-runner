'use strict';
/**
 * A multi-root window: a Vitest front end and a pytest project as two
 * workspace folders. The switcher lists both; each runs on its own and
 * matches its plain runner; the Python environment chip shows only for the
 * pytest project; with both sessions on, a save wakes only its own project;
 * Stop All leaves no Vitest or pytest process.
 */
const path = require('path');
const h = require('../lib/harness');

async function idle(ctx) {
  await h.sleep(1500);
  await h.waitFor(() => !ctx.session.isRunning() && ctx.session._activeRuns === 0, { what: `${ctx.name} to finish`, timeout: 120_000 });
}

const counts = (ctx) => { const s = ctx.store.getSummary(); return { total: s.total, passed: s.passed, failed: s.failed }; };

module.exports = {
  workspace: ['fixture:vitest-basic', 'fixture:pytest-basic'],
  settings: { 'liveTestRunner.onSaveDebounceMs': 100, 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspaces }) {
    const [webDir, pyDir] = workspaces;
    const reg = api.projects;
    t.eq('two workspace folders open', (vscode.workspace.workspaceFolders ?? []).length, 2);
    t.eq('one project per folder, each with its framework', reg.contexts.map((c) => [c.name, c.framework]),
      [['ltr-fixture-vitest-basic', 'vitest'], ['pytest-basic-fixture', 'pytest']]);
    const [web, py] = reg.contexts;
    t.eq('the Explorer switcher lists both', api.explorerView._projects.map((p) => p.name), ['ltr-fixture-vitest-basic', 'pytest-basic-fixture']);

    // ── Front end ──────────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.selectProject', web.id);
    await h.waitForDiscovery(api);
    t.check('status bar names the front end', /^Live Tests: ltr-fixture-vitest-basic · /.test(api.statusBar.text), api.statusBar.text);
    t.check('no Python chip for the front end', !api.explorerView._pythonEnv, JSON.stringify(api.explorerView._pythonEnv));
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(web);
    h.checkMatchesPlainVitest(api, t, webDir, 'front end matches plain Vitest');

    // ── pytest project ─────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.selectProject', py.id);
    await h.waitForDiscovery(api);
    t.check('status bar follows the switch', /^Live Tests: pytest-basic-fixture · /.test(api.statusBar.text), api.statusBar.text);
    await h.waitFor(() => api.explorerView._pythonEnv && !/detecting/.test(api.explorerView._pythonEnv.text), { what: 'the Python chip', timeout: 30_000 });
    t.check('the Python chip shows for the pytest project', /^Python 3\.\d+\.\d+ · \.venv · pytest /.test(api.explorerView._pythonEnv.text), api.explorerView._pythonEnv.text);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(py);
    h.checkMatchesPlainPytest(api, t, pyDir, 'pytest project matches plain pytest');
    t.eq('both sessions are on', [web.session.isActive(), py.session.isActive()], [true, true]);
    t.check("each store has its own folder's files only",
      web.store.getAllFiles().every((f) => f.filePath.startsWith(webDir)) && py.store.getAllFiles().every((f) => f.filePath.startsWith(pyDir)));

    // ── A save wakes only its own project ──────────────────────────────────
    let mark = h.rawMark(api);
    const webBefore = counts(web);
    await h.editAndSave(vscode, path.join(pyDir, 'src', 'shop', 'pricing.py'), (s) => s + '\n');
    await idle(py);
    let raw = h.rawSince(api, mark);
    t.check('saving a .py file reruns pytest', raw.some((l) => /^\[pytest#\d+\] > /.test(l)), raw.filter((l) => / > /.test(l)).join('\n'));
    t.check('…and starts no Vitest', !raw.some((l) => /^\[vitest#\d+\] > /.test(l)), raw.filter((l) => / > /.test(l)).join('\n'));
    t.eq("…the front end's results are untouched", counts(web), webBefore);

    mark = h.rawMark(api);
    const pyBefore = counts(py);
    await h.editAndSave(vscode, path.join(webDir, 'src', 'math.js'), (s) => s + '\n');
    await idle(web);
    raw = h.rawSince(api, mark);
    t.check('saving a front-end file reruns Vitest', raw.some((l) => /^\[vitest#\d+\] > /.test(l)), raw.filter((l) => / > /.test(l)).join('\n'));
    t.check('…and starts no pytest', !raw.some((l) => /^\[pytest#\d+\] > /.test(l)), raw.filter((l) => / > /.test(l)).join('\n'));
    t.eq("…the pytest project's results are untouched", counts(py), pyBefore);

    // ── Stop everything ────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    t.eq('Stop All Projects stops both', reg.contexts.map((c) => c.session.isActive()), [false, false]);
    await h.sleep(3000);
    const left = [...h.vitestProcesses(webDir), ...h.pytestProcesses(pyDir)];
    t.check('no Vitest or pytest process left', left.length === 0, left.join('\n'));
  },
};
