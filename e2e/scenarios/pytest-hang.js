'use strict';
/**
 * A hanging pytest test (an endless sleep): the batch is stopped once that
 * test has run for hangTimeoutSeconds (the plugin's per-test heartbeats), only
 * that file is failed, and the batch's other unfinished files are retried and
 * get their results. No pytest process is left behind.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 6 * 60_000,
  settings: { 'liveTestRunner.hangTimeoutSeconds': 10 },

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'tests', 'test_hang.py'),
      'import time\n\n\ndef test_sleeps_forever():\n    while True:\n        time.sleep(1)\n');
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('test_hang.py')),
      { what: 'test_hang.py to be discovered', timeout: 30_000 });

    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);
    t.info(`full run took ${((Date.now() - started) / 1000).toFixed(0)}s`);

    const hung = h.nodeByName(api, 'tests/test_hang.py', 'test_sleeps_forever');
    t.eq('the hanging test is failed', hung?.status, 'failed');
    t.check('…and says it hung', (hung?.failureMessages[0] || '').includes('hangs'), JSON.stringify(hung?.failureMessages));
    t.check('the log names the test that hung', logs.some((l) => /test_hang\.py has run for \d+s without finishing \(test "test_sleeps_forever"\)/.test(l)),
      logs.filter((l) => /warn/.test(l)).join('\n'));
    t.check('the wording names pytest, not Jest', !logs.some((l) => /plain Jest|instrumented run/.test(l)), logs.filter((l) => /Jest/.test(l)).join('\n'));
    t.eq('the files after it still ran', h.sortedCounts(api, 'tests/test_unittest_style.py'), { passed: 2 });
    t.eq('…and before it', h.sortedCounts(api, 'tests/test_cart.py'), { failed: 2, passed: 9, skipped: 2 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    await h.sleep(4000);
    t.check('no pytest process left behind', h.pytestProcesses(workspace).length === 0, h.pytestProcesses(workspace).join('\n'));
  },
};
