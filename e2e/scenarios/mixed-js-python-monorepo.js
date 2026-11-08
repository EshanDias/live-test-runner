'use strict';
/**
 * A JS root without Python of its own and a backend/ folder with its own
 * pytest config: two projects — Jest at the root,
 * pytest in backend/ with the root's .venv. Each runs on its own; the Jest
 * project never runs Python files and the other way round.
 */
const path = require('path');
const h = require('../lib/harness');

const counts = (ctx) => { const s = ctx.store.getSummary(); return { total: s.total, passed: s.passed, failed: s.failed }; };
async function idle(ctx) {
  await h.sleep(1500);
  await h.waitFor(() => !ctx.session.isRunning(), { what: `${ctx.name} to finish`, timeout: 120_000 });
}

module.exports = {
  workspace: 'fixture:mixed-js-python-monorepo',
  settings: { 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    t.eq('a Jest project at the root and a pytest project in backend/',
      reg.contexts.map((c) => [path.relative(workspace, c.root) || '.', c.framework, c.frameworkLabel]), [['.', 'jest', 'jest'], ['backend', 'pytest', 'pytest']]);
    const [web, backend] = reg.contexts;

    await vscode.commands.executeCommand('liveTestRunner.selectProject', web.id);
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(web);
    t.eq('the root project runs the JS tests only', counts(web), { total: 1, passed: 1, failed: 0 });
    t.check('…and has no Python file', web.store.getAllFiles().every((f) => !/\.py$/.test(f.filePath)));

    await vscode.commands.executeCommand('liveTestRunner.selectProject', backend.id);
    await h.waitForDiscovery(api);
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(backend);
    t.eq('backend runs its pytest tests', counts(backend), { total: 2, passed: 2, failed: 0 });
    h.checkMatchesPlainPytest(api, t, path.join(workspace, 'backend'), 'backend matches plain pytest in its folder');
    const logs = h.logsSince(api, since);
    t.check("backend uses the root's .venv", logs.some((l) => /backend: Python .* — .*\.venv.* \(\.venv \(workspace folder\)\)/.test(l)), logs.filter((l) => /Python/.test(l)).join('\n'));

    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    await h.sleep(2000);
    t.eq('no pytest process left', h.pytestProcesses(workspace), []);
    t.eq('no Jest process left', h.jestProcesses(workspace), []);
  },
};
