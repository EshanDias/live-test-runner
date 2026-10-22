'use strict';
/**
 * Saving the Jest config during a session (task 6.2): the session restarts —
 * config and runnable files are re-read, every test reruns. The config gets
 * its exact content back.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const config = path.join(workspace, 'jest.config.js');
    const original = fs.readFileSync(config, 'utf8');
    try {
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      const files = api.store.getAllFiles().filter((f) => !f.excluded).length;

      const rec = h.recordEvents(api);
      const since = h.isoNow();
      await h.editAndSave(vscode, config, (s) => s + '\n// touched\n');
      await h.waitFor(() => rec.of('run-finished').length > 0, { what: 'the restarted full run', timeout: 120_000 });
      const logs = h.logsSince(api, since);
      t.check('saving jest.config.js restarts the session', logs.some((l) => /jest\.config\.js — the Jest config changed, restarting/.test(l)), logs.join('\n'));
      const started = rec.of('run-started');
      t.check(`…and every test file reruns (${files})`, started.length === 1 && started[0].fileCount === files, JSON.stringify(started));
      t.eq('…nothing left running', h.nodesWithStatus(api, 'running').length, 0);
      rec.stop();
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      fs.writeFileSync(config, original);
    }
  },
};
