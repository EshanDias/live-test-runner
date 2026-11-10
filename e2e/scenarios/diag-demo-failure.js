'use strict';
/**
 * Not a test: records the README still of a failure on its failing line, on
 * the demo-jest shop. VAT goes from 0.2 to 0.25, so "total includes tax"
 * fails; the message shows after its `expect` line and the hover is open
 * (full message, Show diff).
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-demo-failure
 *   sips -c 892 1456 --cropOffset 72 92 /tmp/shots/jest-failure-hover.png \
 *     --out packages/vscode-extension/resources/images/failure-on-line.png
 *
 * Writes <shots>/jest-failure-hover.png: the whole window, because a clipped
 * capture closes the hover before it takes the frame. The crop is the editor
 * from its tab bar down to line 28 (device px, 2×).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');
const { devtools } = require('../lib/devtools');
const { SETTINGS, VIEW } = require('../lib/demo');

module.exports = {
  workspace: 'fixture:demo-jest',
  timeoutMs: 4 * 60_000,
  settings: SETTINGS,

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const cdp = await devtools(port);
    fs.mkdirSync(out, { recursive: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });

    const pricing = path.join(workspace, 'src', 'pricing.js');
    const testFile = path.join(workspace, 'src', 'cart.test.js');
    const original = fs.readFileSync(pricing, 'utf8');
    // Broken before anything runs, so no file-watcher rerun follows the full run.
    fs.writeFileSync(pricing, original.replace('const VAT = 0.2;', 'const VAT = 0.25;'));
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await h.waitForDiscovery(api);
      await h.sleep(1500);

      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      await h.sleep(600);
      await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = doc.getText().split('\n').findIndex((l) => l.includes('expect(cart.total()).toBe(36)'));
      await h.waitFor(() => api.session._activeRuns === 0 && !api.session.isRunning()
        && api.failureDecorations.marks(doc).some((m) => m.line === line + 1), { what: 'the failure on its line', timeout: 120_000 });
      await h.sleep(1000);
      // In the indentation: no type hover from the language server, only ours.
      const col = 1;
      editor.selection = new vscode.Selection(line, col, line, col);
      // Line 12 at the top: the passing test above, the failing one, the next one below.
      editor.revealRange(new vscode.Range(line - 9, 0, line - 9, 0), vscode.TextEditorRevealType.AtTop);
      // The editor alone: the Results panel opens after a failing run and takes focus.
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await h.sleep(1200);
      // showHover can be ignored, or the hover close again, while the editor
      // settles (focus, a late CodeLens pass): capture once the page shows it.
      const hoverShown = async () => (await cdp.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.monaco-hover')].some((e) => e.offsetParent && e.innerText.includes('Show diff'))`,
        returnByValue: true,
      })).result.value === true;
      let png;
      for (let i = 0; i < 8 && !png; i++) {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('editor.action.showHover');
        await h.sleep(1200);
        if (await hoverShown()) { png = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data; }
      }
      t.check('captured jest-failure-hover.png with the hover open', !!png);
      if (png) { fs.writeFileSync(path.join(out, 'jest-failure-hover.png'), Buffer.from(png, 'base64')); }
    } finally {
      fs.writeFileSync(pricing, original);
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
