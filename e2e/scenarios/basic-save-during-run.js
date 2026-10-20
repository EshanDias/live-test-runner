'use strict';
/**
 * Saving files while the full suite runs (BUG-15, BUG-23 #4): "finished" is
 * announced once, after everything; progress never exceeds 100%; a save does
 * not cancel the batch that is running the same file.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const slowPath = path.join(workspace, 'src', 'slow.test.js');
    fs.writeFileSync(slowPath, "test('takes a while', () => new Promise((r) => setTimeout(r, 20000)), 60000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')),
      { what: 'slow.test.js to be discovered', timeout: 30_000 });

    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const full = vscode.commands.executeCommand('liveTestRunner.startTesting');

    // While slow.test.js is still running, save another test file and the slow one itself.
    await h.waitFor(() => h.fileBySuffix(api, 'src/slow.test.js').status === 'running', { what: 'slow.test.js to start', timeout: 60_000 });
    await h.editAndSave(vscode, path.join(workspace, 'src', 'math.test.js'), (s) => s + '\n// saved during the run\n');
    await h.sleep(1500);
    await h.editAndSave(vscode, slowPath, (s) => s + '\n// saved while running\n');

    await full;
    await h.waitFor(() => rec.of('run-finished').length > 0 && api.session._activeRuns === 0, { what: 'all runs to finish', timeout: 120_000 });
    await h.sleep(1500);
    const logs = h.logsSince(api, since);

    const finished = rec.of('run-finished');
    t.eq('BUG-15 exactly one run-finished for the overlapping runs', finished.length, 1);
    t.check('BUG-15 nothing was running when run-finished was sent', finished.every((e) => e.running === 0), JSON.stringify(finished));
    const slowEvents = rec.events.filter((e) => e.type === 'file-result' && e.file === 'slow.test.js');
    const slowDone = slowEvents[slowEvents.length - 1];
    t.check('BUG-15 run-finished came after slow.test.js finished', slowDone && finished[0] && finished[0].at >= slowDone.at,
      JSON.stringify({ slowDone, finished }));

    const progress = rec.of('run-progress');
    const over = progress.filter((p) => p.completed > p.total);
    t.check('BUG-15 progress never exceeds 100%', over.length === 0, JSON.stringify(over.slice(0, 5)));
    t.check('BUG-15 progress was reported', progress.length > 0);

    const cancels = logs.filter((l) => /cancelling b\d+/.test(l));
    t.check('BUG-23 a save does not cancel the running batch', cancels.length === 0, cancels.join('\n'));
    t.eq('results are complete: math', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('results are complete: slow', h.statusCounts(api, 'src/slow.test.js'), { passed: 1 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    rec.stop();
  },
};
