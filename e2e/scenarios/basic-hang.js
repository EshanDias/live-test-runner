'use strict';
/**
 * Hanging tests (BUG-23 #5): an infinite loop is stopped after
 * hangTimeoutSeconds and marked failed, a never-resolving promise fails on
 * Jest's own timeout, and every other file still gets its result.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 5 * 60_000,
  settings: { 'liveTestRunner.hangTimeoutSeconds': 15 },

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'src', 'loop.test.js'),
      "test('spins forever', () => { while (true) { /* hang */ } });\n");
    fs.writeFileSync(path.join(workspace, 'src', 'never.test.js'),
      "test('never resolves', () => new Promise(() => {}));\n");
    // Learnt from copy-requisition: a file that is merely slow to LOAD (App.test.js
    // took 229 s on a cold cache) must not be stopped as hung — only a test may.
    fs.writeFileSync(path.join(workspace, 'src', 'slowload.js'),
      'const end = Date.now() + 20000;\nwhile (Date.now() < end) { /* slow import */ }\nmodule.exports = { ready: true };\n');
    fs.writeFileSync(path.join(workspace, 'src', 'slowload.test.js'),
      "const { ready } = require('./slowload');\ntest('loads slowly, runs fast', () => { expect(ready).toBe(true); });\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => ['loop.test.js', 'never.test.js', 'slowload.test.js'].every((n) => api.store.getAllFiles().some((f) => f.filePath.endsWith(n))),
      { what: 'the new test files to be discovered', timeout: 30_000 });

    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);
    t.info(`full run took ${((Date.now() - started) / 1000).toFixed(0)}s`);

    const loop = h.nodeByName(api, 'src/loop.test.js', 'spins forever');
    t.eq('BUG-23 infinite loop is marked failed', loop.status, 'failed');
    t.check('BUG-23 its failure says it hung', (loop.failureMessages[0] || '').includes('hangs'), JSON.stringify(loop.failureMessages));
    t.check('BUG-23 the log names the hanging file', logs.some((l) => /loop\.test\.js has run for \d+s without finishing/.test(l)),
      logs.filter((l) => /warn/.test(l)).join('\n'));

    const never = h.nodeByName(api, 'src/never.test.js', 'never resolves');
    t.eq('never-resolving promise fails on the test timeout', never.status, 'failed');

    t.eq('a file slow to load (20 s > 15 s limit) is not stopped as hung', h.statusCounts(api, 'src/slowload.test.js'), { passed: 1 });
    t.check('the slow-loading file is not named as hanging', !logs.some((l) => /slowload\.test\.js has run for/.test(l)));
    t.eq('other files still ran: math', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('other files still ran: strings', h.statusCounts(api, 'src/strings.test.js'), { passed: 4 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.check('no Jest process left behind', h.jestProcesses(workspace).length === 0, h.jestProcesses(workspace).join('\n'));
  },
};
