'use strict';
/**
 * Not a test: captures README / guide screenshots of the real UI.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-screenshots
 *
 * VS Code is started with a DevTools port; this scenario sets up each state
 * (a mixed Jest + Vitest project after a run, its coverage in the editor,
 * the Results panel) and captures the window over the DevTools protocol.
 * `diag-` scenarios are never part of `--all`.
 */
const path = require('path');
const h = require('../lib/harness');

const { devtools, shooter } = require('../lib/devtools');

module.exports = {
  workspace: 'fixture:mixed-same-package',
  timeoutMs: 6 * 60_000,
  settings: {
    'workbench.colorTheme': 'Default Dark Modern',
    'window.zoomLevel': 0,
    'editor.minimap.enabled': false,
    'workbench.tips.enabled': false,
    'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  },

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const cdp = await devtools(port);
    const shot = await shooter(cdp, out, t);
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });

      // 1. Explorer grouped by framework + status bar split, a Vitest test open.
      const doc = await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'mul.vitest.js'));
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await shot('mixed-explorer', { x: 0, y: 36, width: 760, height: 864 });

      // 2. The shared source file: coverage from both frameworks.
      const math = await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'math.js'));
      await vscode.window.showTextDocument(math, { preview: false });
      await shot('mixed-coverage', { x: 0, y: 36, width: 1440, height: 524 });

    } finally {
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
