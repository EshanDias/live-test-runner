'use strict';
/**
 * Stop during a run (BUG-08, BUG-15 #4, BUG-23 #3): every Jest process dies,
 * no results or fallback runs arrive afterwards, and nothing keeps spinning.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    // A test that takes a minute, so Stop lands mid-run.
    fs.writeFileSync(path.join(workspace, 'src', 'slow.test.js'),
      "test('takes a minute', () => new Promise((r) => setTimeout(r, 60000)), 90000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')),
      { what: 'slow.test.js to be discovered', timeout: 30_000 });

    const startPromise = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.rawOutput.some((l) => /slow\.test\.js/.test(l) && /RUNS|jest#/.test(l)) ||
      h.jestProcesses(workspace).length > 0, { what: 'Jest to start', timeout: 60_000 });
    await h.waitFor(() => h.fileBySuffix(api, 'src/math.test.js').status === 'passed',
      { what: 'the fast files to finish', timeout: 60_000 });
    t.check('a Jest process is running before Stop', h.jestProcesses(workspace).length > 0);

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    const stoppedAt = Date.now();
    const rawAtStop = h.rawMark(api);
    const statusAtStop = JSON.stringify(h.allNodes(api).map((n) => [n.id, n.status]));

    await h.sleep(3000);
    const left = h.jestProcesses(workspace);
    t.check('BUG-08 no Jest process left 3s after Stop', left.length === 0, left.join('\n'));

    await startPromise;
    await h.sleep(5000);
    const newProcs = h.rawSince(api, rawAtStop).filter((l) => /^\[jest#\d+\] > /.test(l));
    t.check('BUG-15 no new Jest process started after Stop (no fallback)', newProcs.length === 0, newProcs.join('\n'));
    t.check('BUG-08 no results applied after Stop',
      JSON.stringify(h.allNodes(api).map((n) => [n.id, n.status])) === statusAtStop || h.nodesWithStatus(api, 'running').length === 0,
      'statuses changed after Stop');
    t.eq('BUG-23 Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.info(`checked ${((Date.now() - stoppedAt) / 1000).toFixed(0)}s after Stop`);
  },
};
