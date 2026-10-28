'use strict';
/**
 * Not a test: README / guide screenshot of the project switcher in a
 * monorepo (two packages running). See diag-screenshots.js for the setup:
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-screenshots-monorepo
 */
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter } = require('../lib/devtools');

const SLOW = "test('a slow one', () => new Promise((r) => setTimeout(r, 25000)), 60000);\n";

module.exports = {
  workspace: 'fixture:mixed-monorepo',
  timeoutMs: 6 * 60_000,
  settings: {
    'workbench.colorTheme': 'Default Dark Modern',
    'editor.minimap.enabled': false,
    'liveTestRunner.maxRunningProjects': 2,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.commandCenter.enabled': false,
  },

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const fs = require('fs');
    const slow = path.join(workspace, 'packages', 'api', 'src', 'slow.test.js');
    fs.writeFileSync(slow, SLOW);
    const cdp = await devtools(port);
    const shot = await shooter(cdp, out, t);
    const byName = Object.fromEntries(api.projects.contexts.map((c) => [c.name, c]));
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      // shared (Jest + Vitest) finishes; api keeps running in the background while shared is shown.
      await vscode.commands.executeCommand('liveTestRunner.selectProject', byName.api.id);
      await h.waitForDiscovery(api);
      void vscode.commands.executeCommand('liveTestRunner.startTesting');
      await vscode.commands.executeCommand('liveTestRunner.selectProject', byName.shared.id);
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => !byName.shared.session.isRunning() && byName.shared.session.isActive(), { what: 'shared', timeout: 120_000 });
      const doc = await vscode.workspace.openTextDocument(path.join(workspace, 'packages', 'shared', 'src', 'new.vitest.js'));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await shot('monorepo-switcher', { x: 0, y: 36, width: 760, height: 864 });
    } finally {
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
      fs.rmSync(slow, { force: true });
    }
  },
};
