'use strict';
/**
 * Not a test: screenshots of the coverage bars (left edge of each line) with
 * a breakpoint in the gutter, before and after an unsaved edit.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-coverage-bars
 */
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter } = require('../lib/devtools');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,
  settings: {
    'workbench.colorTheme': process.env.LTR_E2E_THEME || 'Default Dark Modern',
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
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      await vscode.commands.executeCommand('workbench.action.closePanel');

      const uri = vscode.Uri.file(path.join(workspace, 'src', 'math.js'));
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(1, 0)))]);
      await h.waitFor(() => api.coverageDecorations.drawnLines(uri.fsPath)?.covered.length > 0, { what: 'bars' });
      await h.sleep(800);
      await shot('coverage-bars');

      await editor.edit((e) => e.insert(new vscode.Position(4, 0), '// a new line\n'));
      await h.sleep(800);
      await shot('coverage-bars-edited');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
      cdp.close?.();
    }
  },
};
