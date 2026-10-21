'use strict';
/**
 * Stop during a Vitest run: every Vitest process (CLI and workers) dies, no
 * results or retries arrive afterwards, and nothing keeps spinning.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'src', 'slow.test.js'),
      "import { test } from 'vitest';\ntest('takes a minute', () => new Promise((r) => setTimeout(r, 60000)), 90000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')),
      { what: 'slow.test.js to be discovered', timeout: 30_000 });

    const startPromise = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.rawOutput.some((l) => /^\[vitest#\d+\] > .* run .*slow\.test\.js/.test(l)),
      { what: 'the batch with slow.test.js to start', timeout: 60_000 });
    await h.sleep(3000); // let Vitest start its workers
    t.check('a Vitest process is running before Stop', h.vitestProcesses(workspace).length > 0);

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    const rawAtStop = h.rawMark(api);
    const statusAtStop = JSON.stringify(h.allNodes(api).map((n) => [n.id, n.status]));

    await h.sleep(4000);
    const left = h.vitestProcesses(workspace);
    t.check('no Vitest process left 4s after Stop', left.length === 0, left.join('\n'));

    await startPromise;
    await h.sleep(4000);
    const newProcs = h.rawSince(api, rawAtStop).filter((l) => /^\[vitest#\d+\] > /.test(l));
    t.check('no new Vitest process after Stop (no retry, no fallback)', newProcs.length === 0, newProcs.join('\n'));
    t.check('no results applied after Stop',
      JSON.stringify(h.allNodes(api).map((n) => [n.id, n.status])) === statusAtStop || h.nodesWithStatus(api, 'running').length === 0,
      'statuses changed after Stop');
    t.eq('Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
