'use strict';
/**
 * The speed setting (liveTestRunner.speed, strict): Light runs one test process at a
 * time, so the whole fixture is one batch; switching to Full while the
 * session is on applies to the next run, with the batches the budget allows
 * on this machine. Results are the same either way.
 */
const path = require('path');
const h = require('../lib/harness');

const runner = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'utils', 'resources.js'));

/** The Jest batch processes started since `mark` (the count of files' own processes are left out). */
function batchCommands(api, mark) {
  return h.rawSince(api, mark).filter((l) => /^\[jest#\d+\] > .*--runTestsByPath/.test(l));
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 5 * 60_000,
  // Strict: the level exactly (adapting, an idle machine would run more than Light).
  settings: { 'liveTestRunner.speed': 'light', 'liveTestRunner.speedStrict': true },

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    const files = api.store.getAllFiles().length;

    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
    t.eq('Light: one test process for the whole run', batchCommands(api, mark).length, 1);
    t.check('…with one worker', batchCommands(api, mark).every((l) => /--maxWorkers=1\b/.test(l)), batchCommands(api, mark).join('\n'));
    const light = h.statusCounts(api, 'src/math.test.js');
    t.eq('results as usual', light, { passed: 5, skipped: 2 });

    // Full, while the session is on: the next run uses it.
    const since = h.isoNow();
    await vscode.workspace.getConfiguration('liveTestRunner').update('speed', 'full', vscode.ConfigurationTarget.Workspace);
    await h.waitFor(() => h.logsSince(api, since).some((l) => /Speed full \(strict\): up to \d+ test process\(es\) at once/.test(l)), { what: 'the speed log line', timeout: 10_000 });
    t.check('the change is logged once, with what it allows', h.logsSince(api, since).filter((l) => /Speed full/.test(l)).length === 1, h.logsSince(api, since).join('\n'));

    const p = runner.parallelBatches(runner.coreCount(), 'full');
    const size = Math.max(5, Math.min(50, Math.ceil(files / p)));
    const expected = Math.ceil(files / size);
    const mark2 = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the run at Full', timeout: 180_000 });
    t.eq(`Full: ${expected} batch(es) of ${files} files (${p} at once on ${runner.coreCount()} cores)`, batchCommands(api, mark2).length, expected);
    t.eq('the same results', h.statusCounts(api, 'src/math.test.js'), light);
    // Not strict (the default): the level is where runs start, the budget follows the machine.
    const since2 = h.isoNow();
    await vscode.workspace.getConfiguration('liveTestRunner').update('speedStrict', false, vscode.ConfigurationTarget.Workspace);
    await h.waitFor(() => h.logsSince(api, since2).some((l) => /Speed full, adapting: from \d+ to \d+ worker\(s\)/.test(l)), { what: 'the adaptive speed line', timeout: 10_000 });
    t.check('without strict, runs adapt between Light and Full', true);
    await vscode.workspace.getConfiguration('liveTestRunner').update('speed', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace.getConfiguration('liveTestRunner').update('speedStrict', undefined, vscode.ConfigurationTarget.Workspace);
  },
};
