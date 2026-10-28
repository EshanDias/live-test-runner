'use strict';
/**
 * Stop during a pytest run: the pytest process dies, no results or retries
 * arrive afterwards, and nothing keeps spinning.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'tests', 'test_slow.py'), 'import time\n\n\ndef test_takes_a_minute():\n    time.sleep(60)\n');
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('test_slow.py')), { what: 'test_slow.py to be discovered', timeout: 30_000 });

    const startPromise = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.rawOutput.some((l) => /^\[pytest#\d+\] > .* -m pytest .*test_slow\.py/.test(l)), { what: 'the batch with test_slow.py to start', timeout: 60_000 });
    await h.sleep(2500);
    t.check('a pytest process is running before Stop', h.pytestProcesses(workspace).length > 0);

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    const rawAtStop = h.rawMark(api);
    await h.sleep(4000);
    const left = h.pytestProcesses(workspace);
    t.check('no pytest process left 4s after Stop', left.length === 0, left.join('\n'));

    await startPromise;
    await h.sleep(3000);
    const newProcs = h.rawSince(api, rawAtStop).filter((l) => /^\[pytest#\d+\] > /.test(l));
    t.check('no new pytest process after Stop (no retry, no fallback)', newProcs.length === 0, newProcs.join('\n'));
    t.eq('Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
