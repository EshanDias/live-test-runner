'use strict';
/**
 * Saving files while a Vitest run is going: "finished" is announced once,
 * after everything; progress never exceeds 100%; a saved file that is still
 * running in the batch gets the newer run's result.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const slowPath = path.join(workspace, 'src', 'slow.test.js');
    fs.writeFileSync(slowPath, "import { test } from 'vitest';\ntest('takes a while', () => new Promise((r) => setTimeout(r, 15000)), 60000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')),
      { what: 'slow.test.js to be discovered', timeout: 30_000 });

    const rec = h.recordEvents(api);
    const full = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => h.fileBySuffix(api, 'src/slow.test.js').status === 'running', { what: 'slow.test.js to start', timeout: 60_000 });
    await h.editAndSave(vscode, path.join(workspace, 'src', 'math.test.js'), (s) => s + '\n// saved during the run\n');
    await h.sleep(1500);
    await h.editAndSave(vscode, slowPath, (s) => s + '\n// saved while running\n');

    await full;
    await h.waitFor(() => rec.of('run-finished').length > 0 && api.session._activeRuns === 0, { what: 'all runs to finish', timeout: 120_000 });
    await h.sleep(1500);

    const finished = rec.of('run-finished');
    t.eq('exactly one run-finished for the overlapping runs', finished.length, 1);
    t.check('nothing was running when run-finished was sent', finished.every((e) => e.running === 0), JSON.stringify(finished));
    const over = rec.of('run-progress').filter((p) => p.completed > p.total);
    t.check('progress never exceeds 100%', over.length === 0, JSON.stringify(over.slice(0, 5)));
    t.eq('results are complete: math', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('results are complete: slow', h.statusCounts(api, 'src/slow.test.js'), { passed: 1 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    await h.sleep(1000);
    t.check('no Vitest process left behind', h.vitestProcesses(workspace).length === 0, h.vitestProcesses(workspace).join('\n'));
    rec.stop();
  },
};
