'use strict';
/**
 * Stop with two projects running: Stop on one kills only its
 * Jest processes — the other keeps running and finishes; stopping the second
 * leaves no process behind.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const runner = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'utils', 'resources.js'));

const SLOW = (secs) => `test('takes a while', () => new Promise((r) => setTimeout(r, ${secs * 1000})), ${(secs + 30) * 1000});\n`;

module.exports = {
  workspace: 'fixture:monorepo-jest',
  settings: { 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'packages', 'app-a', 'src', 'slow.test.js'), SLOW(60));
    fs.writeFileSync(path.join(workspace, 'packages', 'app-b', 'src', 'slow.test.js'), SLOW(12));

    const reg = api.projects;
    const [a, b] = reg.contexts;
    t.eq('projects', reg.contexts.map((c) => c.name), ['app-a', 'app-b']);

    await h.waitForDiscovery(api);
    await h.waitFor(() => a.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')), { what: 'app-a slow.test.js', timeout: 30_000 });
    const aStart = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await vscode.commands.executeCommand('liveTestRunner.selectProject', b.id);
    await h.waitForDiscovery(api);
    await h.waitFor(() => b.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')), { what: 'app-b slow.test.js', timeout: 30_000 });
    const bStart = vscode.commands.executeCommand('liveTestRunner.startTesting');

    // Each project's Jest CLI names its own folder (the test files, --config in its transform cache).
    const jestOf = (c) => h.jestProcesses(c.root + path.sep);
    // Both at once where the budget allows two processes; with one (a small machine), app-b's waits for app-a's.
    const together = runner.parallelBatches(runner.coreCount(), 'balanced') > 1;
    await h.waitFor(() => (together ? jestOf(a).length > 0 && jestOf(b).length > 0 : jestOf(a).length + jestOf(b).length > 0),
      { what: together ? 'both projects\' Jest to run' : 'a project\'s Jest to run', timeout: 90_000 });
    t.check('the session folders differ per project', a.sessionDir !== b.sessionDir && !b.sessionDir.startsWith(a.sessionDir + path.sep));
    t.eq('both run', reg.running().map((c) => c.name), ['app-a', 'app-b']);

    // ── Stop app-a (not the selected project) ──────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopTesting', a.id);
    await h.sleep(3000);
    t.check('app-a stopped', !a.session.isActive() && !a.session.isRunning());
    const aLeft = jestOf(a);
    t.check('no app-a Jest process left', aLeft.length === 0, aLeft.join('\n'));
    t.eq('nothing of app-a keeps spinning', a.store.getAllFiles().filter((f) => f.status === 'running').map((f) => f.filePath), []);
    t.check('app-b keeps running', b.session.isActive() && (b.session.isRunning() || b.store.getSummary().passed > 0));

    await Promise.all([aStart, bStart]);
    await h.waitFor(() => !b.session.isRunning(), { what: 'app-b to finish', timeout: 120_000 });
    t.eq('app-b finished every test', h.statusCounts(api, 'app-b/src/slow.test.js'), { passed: 1 });
    t.eq('app-b greet.test.js', h.statusCounts(api, 'greet.test.js'), { passed: 3 });
    t.check('app-b is still live after app-a stopped', b.session.isActive());

    // ── Stop app-b too ─────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await h.sleep(3000);
    t.eq('both stopped', reg.contexts.map((c) => c.session.isActive()), [false, false]);
    const left = h.jestProcesses(workspace).concat(jestOf(a), jestOf(b));
    t.check('no Jest process left after stopping both', left.length === 0, left.join('\n'));
    t.check('status bar shows no running project', /^Live Tests: app-b · Off$/.test(api.statusBar.text), api.statusBar.text);
  },
};
