'use strict';
/**
 * Not a test: screenshots of three ways to show coverage, for the maintainers to
 * compare (3.3.0 item 1), each with breakpoints on a covered and an
 * uncovered line:
 *   A — VS Code's own coverage display (Testing API, FileCoverage)
 *   B — faint background tint on uncovered / partly covered lines only
 *   C — the current left edge, thinner and faded
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-coverage-options
 */
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter } = require('../lib/devtools');

const CLIP = { x: 345, y: 36, width: 760, height: 380 };

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,
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
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      await vscode.commands.executeCommand('workbench.action.closePanel');

      const uri = vscode.Uri.file(path.join(workspace, 'src', 'math.js'));
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      await h.waitFor(() => api.coverageDecorations.drawnLines(uri.fsPath)?.covered.length > 0, { what: 'bars' });
      const lines = JSON.parse(JSON.stringify(api.coverageDecorations.drawnLines(uri.fsPath)));
      t.check(`lines ${JSON.stringify(lines)}`, true);
      vscode.debug.addBreakpoints([1, 10].map((l) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(l, 0)))));
      await vscode.commands.executeCommand('liveTestRunner.hideCoverageInEditor');
      await h.sleep(500);

      const range = (l) => new vscode.Range(l, 0, l, 0);

      // ── C: thinner, faded left edge ─────────────────────────────────────
      const thin = (c) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderStyle: 'solid', borderWidth: '0 0 0 1px', borderColor: c });
      const cTypes = [[thin('rgba(34,197,94,0.55)'), lines.covered], [thin('rgba(245,158,11,0.7)'), lines.partial], [thin('rgba(239,68,68,0.7)'), lines.uncovered]];
      for (const [d, ls] of cTypes) { editor.setDecorations(d, ls.map(range)); }
      await shot('option-c-thin-edge', CLIP);
      for (const [d] of cTypes) { d.dispose(); }

      // ── B: faint background, only lines that need attention ─────────────
      const tint = (c) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: c });
      const bTypes = [[tint('rgba(245,158,11,0.10)'), lines.partial], [tint('rgba(239,68,68,0.12)'), lines.uncovered]];
      for (const [d, ls] of bTypes) { editor.setDecorations(d, ls.map(range)); }
      await shot('option-b-tint', CLIP);
      const bGreen = tint('rgba(34,197,94,0.06)');
      editor.setDecorations(bGreen, lines.covered.map(range));
      await shot('option-b-tint-with-green', CLIP);
      for (const [d] of bTypes) { d.dispose(); }
      bGreen.dispose();

      // ── A: VS Code's own coverage display ───────────────────────────────
      const cmds = (await vscode.commands.getCommands(true)).filter((c) => /coverage/i.test(c) && /^testing\./.test(c));
      t.check(`VS Code coverage commands: ${cmds.join(', ')}`, true);
      const ctrl = vscode.tests.createTestController('ltrCoverageDemo', 'Live Test Runner');
      const statements = [
        ...lines.covered.map((l) => new vscode.StatementCoverage(1, new vscode.Position(l, 2))),
        ...lines.uncovered.map((l) => new vscode.StatementCoverage(0, new vscode.Position(l, 2))),
        ...lines.partial.map((l) => new vscode.StatementCoverage(1, new vscode.Position(l, 2), [new vscode.BranchCoverage(1, new vscode.Position(l, 2)), new vscode.BranchCoverage(0, new vscode.Position(l, 2))])),
      ];
      const profile = ctrl.createRunProfile('Coverage', vscode.TestRunProfileKind.Coverage, () => {}, false);
      profile.loadDetailedCoverage = async () => statements;
      const run = ctrl.createTestRun(new vscode.TestRunRequest(undefined, undefined, profile), 'coverage', false);
      const total = statements.length;
      const hit = lines.covered.length + lines.partial.length;
      run.addCoverage(new vscode.FileCoverage(uri, new vscode.TestCoverageCount(hit, total)));
      run.end();
      await h.sleep(1500);
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await vscode.commands.executeCommand('workbench.action.closeSidebar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.explorer');
      await h.sleep(800);
      await shot('option-a-native-as-is', CLIP);
      for (const c of cmds.filter((c) => /inline/i.test(c))) {
        try { await vscode.commands.executeCommand(c); t.check(`ran ${c}`, true); break; } catch (e) { t.check(`${c} failed: ${e.message}`, true); }
      }
      await h.sleep(800);
      await shot('option-a-native', CLIP);
      await shot('option-a-native-full');
      ctrl.dispose();
    } finally {
      cdp.close?.();
    }
  },
};
