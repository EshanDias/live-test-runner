'use strict';
/**
 * Not a test: screenshots of the AI-assistant features in the real UI.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-screenshots-ai
 *
 * A Jest project with a failing test: Fix with AI above the test, the
 * Problems list with its quick fix, the Results panel's button, the Connect
 * page, and what an agent reads through the MCP relay (its answers shown in
 * an editor tab). `diag-` scenarios are never part of `--all`.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter } = require('../lib/devtools');
const { startMcp } = require('../lib/mcpClient');

const SOURCE = 'function total(items) {\n  return items.reduce((sum, item) => sum + item.cost.amount, 0);\n}\nmodule.exports = { total };\n';
const FIXED = 'function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nmodule.exports = { total };\n';
const TEST = "const { total } = require('./cart');\n\ndescribe('cart', () => {\n  test('totals prices', () => {\n    expect(total([{ price: 2 }, { price: 3 }])).toBe(5);\n  });\n\n  test('empty cart', () => {\n    expect(total([])).toBe(0);\n  });\n});\n";

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 8 * 60_000,
  settings: {
    'workbench.colorTheme': 'Default Dark Modern',
    'window.zoomLevel': 0,
    'editor.minimap.enabled': false,
    'workbench.tips.enabled': false,
    'chat.commandCenter.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'editor.fontSize': 15,
    'editor.stickyScroll.enabled': false,
  },

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const src = path.join(workspace, 'src', 'cart.js');
    const testFile = path.join(workspace, 'src', 'cart.test.js');
    fs.writeFileSync(src, SOURCE);
    fs.writeFileSync(testFile, TEST);
    const cdp = await devtools(port);
    const shot = await shooter(cdp, out, t);
    const full = { x: 0, y: 36, width: 1440, height: 864 };
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      api.failureDiagnostics.refresh();

      // 1. The failing test: ✨ Fix with AI above it, the reason on the line.
      const doc = await vscode.workspace.openTextDocument(testFile);
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await shot('ai-1-fix-with-ai-lens', full);

      // 2. The Problems panel, then the quick fix menu on the failure.
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      await shot('ai-2-problems-panel', full);
      const srcDoc = await vscode.workspace.openTextDocument(src);
      const ed = await vscode.window.showTextDocument(srcDoc, { preview: false });
      ed.selection = new vscode.Selection(1, 50, 1, 50);
      await vscode.commands.executeCommand('editor.action.quickFix');
      await shot('ai-3-quick-fix', full);
      await vscode.commands.executeCommand('hideCodeActionWidget').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.action.closePanel');

      // 3. The Results panel: Errors pane with Copy for AI and ✨ Fix with AI.
      const node = h.nodeByName(api, 'src/cart.test.js', 'cart totals prices');
      await vscode.commands.executeCommand('liveTestRunner.focusResult', node.fileId, node.id);
      await shot('ai-4-results-panel', full);

      // 4. Connect Your AI Assistant: Copilot (built in) and Claude Code (one command).
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('liveTestRunner.connectAI', 'copilot');
      await shot('ai-5-connect-copilot', full);
      await vscode.commands.executeCommand('liveTestRunner.connectAI', 'claude');
      await shot('ai-6-connect-claude-code', full);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // 5. What an agent reads through the MCP relay, step by step.
      const mcp = startMcp(api.aiBridge.launcherPath, workspace);
      const lines = ['# What your AI assistant sees', '', 'A terminal agent (here a scripted MCP client) connected through the launcher, from the project folder.', ''];
      try {
        await mcp.initialize();
        const fmt = (name, args, body) => {
          const { isError, ...rest } = body;
          lines.push(`## ${name}(${Object.keys(args).length ? JSON.stringify(args) : ''})`, '', '```json', JSON.stringify(rest, null, 2), '```', '');
        };
        const failures = await mcp.call('LTR_get_failures', { limit: 3 });
        fmt('LTR_get_failures', { limit: 3 }, failures);
        const id = failures.failures[0].id;
        const ex = await mcp.call('LTR_explain_failure', { id });
        fmt('LTR_explain_failure', { id }, ex);
        fs.writeFileSync(src, FIXED);
        const verify = await mcp.finish(await mcp.call('LTR_verify_fix', { files: ['src/cart.js'] }));
        fmt('LTR_verify_fix', { files: ['src/cart.js'] }, verify);
      } finally {
        mcp.close();
      }
      const md = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
      const mdEd = await vscode.window.showTextDocument(md, { preview: false });
      const docLines = lines.join('\n').split('\n');
      const at = (needle) => { const i = docLines.findIndex((l) => l.startsWith(needle)); return i < 0 ? 0 : i; };
      for (const [name, needle] of [['ai-7-agent-get-failures', '## LTR_get_failures'], ['ai-8-agent-explain-failure', '## LTR_explain_failure'], ['ai-9-agent-verify-fix', '## LTR_verify_fix']]) {
        const line = at(needle);
        mdEd.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
        await shot(name, full);
      }

      // 6. After the fix: the Explorer is green again.
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await shot('ai-10-after-fix', full);
    } finally {
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
