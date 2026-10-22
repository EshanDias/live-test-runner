'use strict';
/**
 * "Open Guide" (task 11.4): the guide shipped in out/guide/ opens in an editor
 * tab (a webview), once — running the command again reveals the same tab.
 */
const h = require('../lib/harness');

const guideTabs = (vscode) => vscode.window.tabGroups.all
  .flatMap((g) => g.tabs)
  .filter((tab) => tab.label === 'Live Test Runner Guide' && tab.input instanceof vscode.TabInputWebview);

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 60_000,

  async run({ api, t, vscode }) {
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.openGuide');
    await h.waitFor(() => guideTabs(vscode).length > 0, { what: 'the guide tab', timeout: 10_000 });
    t.eq('the guide opens in one webview tab', guideTabs(vscode).length, 1);
    await vscode.commands.executeCommand('liveTestRunner.openGuide');
    await h.sleep(500);
    t.eq('…opening it again reuses the tab', guideTabs(vscode).length, 1);
    const logs = h.logsSince(api, since);
    t.check('…from the shipped copy (no fallback to the online guide)', !logs.some((l) => /Guide not found/.test(l)), logs.join('\n'));
  },
};
