'use strict';
/**
 * Stop in a mixed-framework project (phase 8): with a slow Jest file and a
 * slow Vitest file running at once, Stop kills both frameworks' processes,
 * nothing keeps spinning, and no retry or fallback starts afterwards.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:mixed-same-package',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const slowJest = path.join(workspace, 'src', 'slow.jest.js');
    const slowVitest = path.join(workspace, 'src', 'slow.vitest.js');
    fs.writeFileSync(slowJest, "test('slow (Jest)', () => new Promise((r) => setTimeout(r, 60000)), 90000);\n");
    fs.writeFileSync(slowVitest, "import { test } from 'vitest';\ntest('slow (Vitest)', () => new Promise((r) => setTimeout(r, 60000)), 90000);\n");
    const ctx = api.projects.contexts[0];
    try {
      await h.waitForDiscovery(api);
      void vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => h.jestProcesses(ctx.sessionDir).length > 0 && h.vitestProcesses(workspace).length > 0,
        { what: 'Jest and Vitest to run', timeout: 120_000 });
      t.check('both frameworks run at once', true);

      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      await h.sleep(4000);
      const jestLeft = h.jestProcesses(ctx.sessionDir).concat(h.jestProcesses(workspace));
      const vitestLeft = h.vitestProcesses(workspace);
      t.check('no Jest process left after Stop', jestLeft.length === 0, jestLeft.join('\n'));
      t.check('no Vitest process left after Stop', vitestLeft.length === 0, vitestLeft.join('\n'));
      t.eq('nothing spinning', api.store.getAllFiles().filter((f) => f.status === 'running').map((f) => f.name), []);
      t.check('the session is off', !api.session.isActive() && !api.session.isRunning());

      await h.sleep(4000);
      const later = h.jestProcesses(workspace).concat(h.jestProcesses(ctx.sessionDir), h.vitestProcesses(workspace));
      t.check('no new process after Stop (no retry, no fallback)', later.length === 0, later.join('\n'));
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      fs.rmSync(slowJest, { force: true });
      fs.rmSync(slowVitest, { force: true });
    }
  },
};
