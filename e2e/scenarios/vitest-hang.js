'use strict';
/**
 * Hanging Vitest tests: an infinite loop blocks a worker, so its batch is
 * stopped after hangTimeoutSeconds × 3; the files are then retried one by
 * one and only the hanging one is failed as hung. A never-resolving promise
 * fails on Vitest's own test timeout. Every other file gets its result.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 6 * 60_000,
  settings: { 'liveTestRunner.hangTimeoutSeconds': 10 },

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'src', 'loop.test.js'),
      "import { test } from 'vitest';\ntest('spins forever', () => { while (true) { /* hang */ } });\n");
    fs.writeFileSync(path.join(workspace, 'src', 'never.test.js'),
      "import { test } from 'vitest';\ntest('never resolves', () => new Promise(() => {}));\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => ['loop.test.js', 'never.test.js'].every((n) => api.store.getAllFiles().some((f) => f.filePath.endsWith(n))),
      { what: 'the new test files to be discovered', timeout: 30_000 });

    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);
    t.info(`full run took ${((Date.now() - started) / 1000).toFixed(0)}s`);

    const loop = h.nodeByName(api, 'src/loop.test.js', 'spins forever');
    t.eq('infinite loop is marked failed', loop?.status, 'failed');
    t.check('its failure says it hung', (loop?.failureMessages[0] || '').includes('hangs'), JSON.stringify(loop?.failureMessages));
    t.check('the log says a batch was stopped for running too long', logs.some((l) => /ran for \d+s without finishing/.test(l)),
      logs.filter((l) => /warn/.test(l)).join('\n'));
    t.check('the wording names Vitest, not Jest', !logs.some((l) => /plain Jest|instrumented run/.test(l)),
      logs.filter((l) => /Jest/.test(l)).join('\n'));

    const never = h.nodeByName(api, 'src/never.test.js', 'never resolves');
    t.eq('never-resolving promise fails on the test timeout', never?.status, 'failed');
    t.eq('other files still ran: math', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('other files still ran: strings', h.statusCounts(api, 'src/strings.test.ts'), { passed: 1, failed: 1 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    await h.sleep(2000);
    t.check('no Vitest process left behind', h.vitestProcesses(workspace).length === 0, h.vitestProcesses(workspace).join('\n'));
  },
};
