'use strict';
/**
 * Python services side by side, each with its own .venv and no shared one
 * (no uv workspace, nothing at the root): each service is its own pytest
 * project, runs with its own .venv (its tests assert sys.prefix), shows what a
 * plain pytest run there reports, and a save reruns only its service.
 */
const path = require('path');
const h = require('../lib/harness');

async function idle(ctx) {
  await h.sleep(1500);
  await h.waitFor(() => !ctx.session.isRunning() && ctx.session._activeRuns === 0, { what: `${ctx.name} to finish`, timeout: 120_000 });
}

const counts = (ctx) => { const s = ctx.store.getSummary(); return { total: s.total, passed: s.passed, failed: s.failed }; };

module.exports = {
  workspace: 'fixture:monorepo-pytest-venvs',
  settings: { 'liveTestRunner.onSaveDebounceMs': 100, 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    t.eq('one pytest project per service', reg.contexts.map((c) => [c.name, c.framework]), [['svc-api', 'pytest'], ['svc-worker', 'pytest']]);
    const [apiSvc, worker] = reg.contexts;
    const apiDir = path.join(workspace, 'services', 'api');
    const workerDir = path.join(workspace, 'services', 'worker');

    for (const [ctx, dir, testFile, expected] of [
      [apiSvc, apiDir, 'tests/test_handlers.py', { total: 3, passed: 3, failed: 0 }],
      [worker, workerDir, 'tests/test_jobs.py', { total: 3, passed: 2, failed: 1 }],
    ]) {
      await vscode.commands.executeCommand('liveTestRunner.selectProject', ctx.id);
      await h.waitForDiscovery(api);
      const since = h.isoNow();
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await idle(ctx);
      const logs = h.logsSince(api, since).filter((l) => /Python 3\.\d+/.test(l));
      const own = path.join(dir, '.venv');
      t.check(`${ctx.name} uses its own .venv`, logs.some((l) => l.includes(own) && /\(\.venv\)/.test(l)), logs.join('\n'));
      t.eq(`${ctx.name} results`, counts(ctx), expected);
      t.eq(`${ctx.name}: sys.prefix is its own .venv`, h.nodeByName(api, testFile, 'test_runs_with_the_services_own_venv')?.status, 'passed');
      h.checkMatchesPlainPytest(api, t, dir, `${ctx.name} matches plain pytest with its .venv`);
    }

    // A save in one service reruns that service only.
    const mark = h.rawMark(api);
    const apiBefore = counts(apiSvc);
    await h.editAndSave(vscode, path.join(workerDir, 'jobs.py'), (s) => s.replace('n * 2', 'n * 2 + 1'));
    await idle(worker);
    const cmds = h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
    t.check('saving worker/jobs.py reruns worker tests with its .venv', cmds.length >= 1 && cmds.every((l) => l.includes(path.join(workerDir, '.venv'))), cmds.join('\n'));
    t.eq('…the edited code now fails test_double', h.nodeByName(api, 'tests/test_jobs.py', 'test_double')?.status, 'failed');
    t.eq("…api's results are untouched", counts(apiSvc), apiBefore);

    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    await h.sleep(2000);
    const left = h.pytestProcesses(workspace);
    t.check('no pytest process left', left.length === 0, left.join('\n'));
  },
};
