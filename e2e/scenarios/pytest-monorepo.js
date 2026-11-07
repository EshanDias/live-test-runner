'use strict';
/**
 * Python monorepo: a uv workspace without a pytest
 * config at its root is one project per member with tests (a member with its
 * own pytest config, one with tests only, a member without tests is none).
 * Each member runs from its own folder with the workspace's shared .venv,
 * shows what a plain pytest run there reports, reruns on save without waking
 * the other member, and Stop All leaves no pytest process.
 */
const path = require('path');
const h = require('../lib/harness');

async function idle(ctx) {
  await h.sleep(1500);
  await h.waitFor(() => !ctx.session.isRunning() && ctx.session._activeRuns === 0, { what: `${ctx.name} to finish`, timeout: 120_000 });
}

const counts = (ctx) => { const s = ctx.store.getSummary(); return { total: s.total, passed: s.passed, failed: s.failed }; };

module.exports = {
  workspace: 'fixture:monorepo-pytest',
  settings: { 'liveTestRunner.onSaveDebounceMs': 100, 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    t.eq('one pytest project per member with tests (docs has none)', reg.contexts.map((c) => [c.name, c.framework]), [['ws-cli', 'pytest'], ['ws-core', 'pytest']]);
    const [cli, core] = reg.contexts;
    const cliDir = path.join(workspace, 'packages', 'cli');
    const coreDir = path.join(workspace, 'packages', 'core');
    t.eq('each member is its own root', [cli.root, core.root].map((r) => path.relative(workspace, r).split(path.sep).join('/')), ['packages/cli', 'packages/core']);

    // ── core: no pytest config of its own, the workspace's .venv ───────────
    await vscode.commands.executeCommand('liveTestRunner.selectProject', core.id);
    await h.waitForDiscovery(api);
    let since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(core);
    let logs = h.logsSince(api, since);
    t.check("core uses the workspace's shared .venv", logs.some((l) => /\bcore: Python 3\.\d+\.\d+ · pytest .* — .*\.venv.* \(\.venv \(workspace folder\)\)/.test(l)),
      logs.filter((l) => /Python/.test(l)).join('\n'));
    t.eq('core results', counts(core), { total: 3, passed: 2, failed: 1 });
    h.checkMatchesPlainPytest(api, t, coreDir, 'core matches plain pytest in its folder');

    // ── cli: its own [tool.pytest.ini_options] (testpaths, pythonpath) ─────
    await vscode.commands.executeCommand('liveTestRunner.selectProject', cli.id);
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(cli);
    t.eq('cli results', counts(cli), { total: 3, passed: 3, failed: 0 });
    h.checkMatchesPlainPytest(api, t, cliDir, 'cli matches plain pytest in its folder');
    t.check("cli's store has cli's files only", cli.store.getAllFiles().every((f) => f.filePath.startsWith(cliDir)));
    t.check("core's store has core's files only", core.store.getAllFiles().every((f) => f.filePath.startsWith(coreDir)));
    t.eq('both sessions are active', [cli.session.isActive(), core.session.isActive()], [true, true]);

    // ── A save in one member reruns that member only ───────────────────────
    const mark = h.rawMark(api);
    const coreBefore = counts(core);
    await h.editAndSave(vscode, path.join(cliDir, 'tests', 'test_greet.py'), (s) => s.replace('"Hello, Ada"', '"Hi, Ada"'));
    await idle(cli);
    const cmds = h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
    t.check('saving a cli test reruns that file', cmds.length >= 1 && cmds.every((l) => /test_greet\.py/.test(l)), cmds.join('\n'));
    t.check('…and never core', !cmds.some((l) => /test_core\.py/.test(l)), cmds.join('\n'));
    t.eq('the edited test now fails', h.nodeByName(api, 'tests/test_greet.py', 'test_greet')?.status, 'failed');
    t.eq("core's results are untouched", counts(core), coreBefore);

    // ── Stop everything ────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    t.eq('Stop All Projects stops both', reg.contexts.map((c) => c.session.isActive()), [false, false]);
    await h.sleep(2000);
    const left = h.pytestProcesses(workspace);
    t.check('no pytest process left', left.length === 0, left.join('\n'));
  },
};
