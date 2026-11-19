'use strict';
/**
 * Not a test: screenshots of console output in the Results panel.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-screenshots-console
 *
 * A checkout test file on fixture:demo-jest that logs at every level
 * (log, info, warn, error), one passing and one failing test. Each test is
 * run on its own (▶ Run), so the panel shows that test's own output; then
 * the whole file. Shots of the maximized Results panel:
 *   console-1-passing-test   log / info / warn lines of a passing test
 *   console-2-failing-test   console.error + the failure and its diff in the Errors pane
 *   console-3-file           the file's output, every level
 *   console-4-editor         the editor + panel together (the test file beside its output)
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter } = require('../lib/devtools');
const { SETTINGS } = require('../lib/demo');

const TEST = `const { Cart } = require('./cart');

describe('Checkout', () => {
  test('charges the card and sends a receipt', () => {
    const cart = new Cart();
    cart.add('book', 12.5, 2);
    cart.add('pen', 5);
    console.log('cart ready', { items: 2, total: 36 });
    console.info('provider: sandbox');
    console.warn('coupon SPRING expired');
    console.log('receipt sent');
    expect(cart.total()).toBe(36);
  });

  test('applies the member discount', () => {
    const cart = new Cart();
    cart.add('lamp', 40);
    console.info('member tier: gold');
    console.warn('code MEMBER not found');
    console.error('pricing: unknown code');
    expect(cart.total('MEMBER')).toBe(43.2);
  });
});
`;

module.exports = {
  workspace: 'fixture:demo-jest',
  timeoutMs: 6 * 60_000,
  settings: { ...SETTINGS, 'editor.fontSize': 15 },

  prepare([ws]) {
    fs.writeFileSync(path.join(ws, 'src', 'checkout.test.js'), TEST);
  },

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const cdp = await devtools(port);
    const shot = await shooter(cdp, out, t);
    const full = { x: 0, y: 36, width: 1440, height: 864 };
    const rel = 'src/checkout.test.js';
    const testFile = path.join(workspace, rel);
    const runAndShow = async (fullName) => {
      const node = h.nodeByName(api, rel, fullName);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName });
      await h.sleep(600);
      await h.waitFor(() => api.session._activeRuns === 0 && !api.session.isRunning(), { what: `${fullName} to run`, timeout: 60_000 });
      await vscode.commands.executeCommand('liveTestRunner.focusResult', node.fileId, node.id);
      return node;
    };
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(testFile), { preview: false });

      // The editor and the panel together: the test beside its own output.
      await runAndShow('Checkout charges the card and sends a receipt');
      await shot('console-4-editor', full);

      // The maximized panel: a passing test's log / info / warn lines.
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await shot('console-1-passing-test', full);

      // A failing test: console.error and the failure with its diff.
      await runAndShow('Checkout applies the member discount');
      await shot('console-2-failing-test', full);

      // The whole file's output.
      const f = h.fileBySuffix(api, rel);
      await vscode.commands.executeCommand('liveTestRunner.focusResult', f.fileId, f.fileId);
      await shot('console-3-file', full);
      await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
    } finally {
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
