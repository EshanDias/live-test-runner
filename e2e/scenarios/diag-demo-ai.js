'use strict';
/**
 * Not a test: records the AI-assistant demo clip on fixture:demo-jest.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-demo-ai
 *
 * A terminal agent (a scripted MCP client: the steps are fixed, the answers
 * are the real ones from the relay) is asked to fix a failing test. It reads
 * the failure through LTR_get_failures and LTR_explain_failure, edits the
 * source, and checks the fix with LTR_verify_fix while the Explorer turns
 * green. Its side of the conversation is printed in a terminal tab.
 *
 * Writes the clip `ai-fix` (frames, see devtools.js `recorder`) plus stills
 * `ai-fix-1-failing`, `ai-fix-2-explained`, `ai-fix-3-verified`.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');
const { devtools, shooter, recorder } = require('../lib/devtools');
const { startMcp } = require('../lib/mcpClient');
const { SETTINGS, VIEW } = require('../lib/demo');

const BUG = 'TENOFF: 0.8';
const FIX = 'TENOFF: 0.9';

// ANSI colours for the terminal tab.
const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', mag: '\x1b[35m', reset: '\x1b[0m' };

module.exports = {
  workspace: 'fixture:demo-jest',
  timeoutMs: 6 * 60_000,
  settings: { ...SETTINGS, 'terminal.integrated.fontSize': 14 },

  /** The bug the agent fixes: TENOFF takes 20% off instead of 10%. */
  prepare([ws]) {
    const file = path.join(ws, 'src', 'pricing.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('TENOFF: 0.9', BUG));
  },

  async run({ api, t, vscode, workspace }) {
    const port = process.env.LTR_E2E_CDP_PORT;
    const out = process.env.LTR_E2E_SHOTS_DIR;
    if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
    const cdp = await devtools(port);
    const shot = await shooter(cdp, out, t);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });
    const rec = recorder(cdp, out);
    const CLIP = { x: 0, y: 36, width: VIEW.width, height: VIEW.height - 36 };

    // The agent's terminal: a pseudoterminal we print into.
    const emitter = new vscode.EventEmitter();
    const pty = { onDidWrite: emitter.event, open() {}, close() {} };
    const print = (s = '') => emitter.fire(s.replace(/\n/g, '\r\n') + '\r\n');
    const type = async (s) => { for (const ch of s) { emitter.fire(ch); await h.sleep(55); } emitter.fire('\r\n'); };
    const say = async (s, pause = 700) => { print(s); await h.sleep(pause); };

    const srcRel = 'src/pricing.js';
    const src = path.join(workspace, srcRel);
    let mcp;
    try {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
      await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      await h.sleep(1000);

      let editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(src), { preview: false });
      // The agent's terminal as an editor beside the source: tall enough for the whole conversation.
      const term = vscode.window.createTerminal({ name: 'AI assistant', pty, location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } });
      term.show(true);
      await vscode.commands.executeCommand('workbench.action.closePanel');
      await h.sleep(1500);
      editor = await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });

      mcp = startMcp(api.aiBridge.launcherPath, workspace);
      await mcp.initialize();

      const stop = await rec('ai-fix', CLIP, 0.5);
      await h.sleep(1200);
      print(`${C.dim}AI assistant · connected to Live Test Runner (MCP)${C.reset}`);
      print('');
      emitter.fire(`${C.bold}${C.cyan}> ${C.reset}`);
      await type('A test is failing. Find out why and fix it.');
      await h.sleep(600);

      // 1. What is failing?
      await say(`\n${C.mag}● LTR_get_failures${C.reset}`, 500);
      const failures = await mcp.call('LTR_get_failures', { limit: 5 });
      const list = failures.failures ?? [];
      await say(`  ${C.red}✗ ${list.length} failing${C.reset}${list[0] ? `: ${list[0].name}` : ''}`, 200);
      if (list[0]) { await say(`  ${C.dim}${list[0].file ?? ''}${list[0].line ? `:${list[0].line}` : ''}${C.reset}`, 1200); }
      await shot('ai-fix-1-failing', CLIP);

      // 2. Why? The error, the failing line and the source lines the test ran.
      const id = list[0]?.id;
      await say(`${C.mag}● LTR_explain_failure${C.reset}`, 500);
      const ex = id ? await mcp.call('LTR_explain_failure', { id }) : {};
      const err = ex.error ?? {};
      if (err.expected !== undefined) {
        await say(`  Expected: ${C.green}${err.expected}${C.reset}  Received: ${C.red}${err.received}${C.reset}`, 500);
      } else if (err.summary) {
        await say(`  ${C.red}${err.summary}${C.reset}`, 500);
      }
      const ran = (ex.linesRun ?? []).find((r) => r.file === srcRel);
      if (ran) { await say(`  ${C.dim}it ran ${srcRel} lines ${ran.lines}${C.reset}`, 900); }
      await say(`\nTENOFF should take 10% off,\nbut the rate is 0.8 (20% off). Fixing it.`, 1200);
      await shot('ai-fix-2-explained', CLIP);

      // 3. The edit, in the editor: 0.8 → 0.9, saved (the live session reruns what it touches).
      await say(`${C.mag}● Edit${C.reset} ${srcRel}`, 400);
      const text = editor.document.getText();
      const at = text.indexOf(BUG) + BUG.length - 1;
      const p = editor.document.positionAt(at);
      editor.selection = new vscode.Selection(p, p.translate(0, 1));
      editor.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      await h.sleep(700);
      await editor.edit((e) => e.replace(new vscode.Range(p, p.translate(0, 1)), FIX.slice(-1)));
      await h.sleep(500);
      await editor.document.save();
      await say(`  ${C.red}- ${BUG}${C.reset}`, 100);
      await say(`  ${C.green}+ ${FIX}${C.reset}`, 700);

      // 4. Verify: reuses the session's own rerun of that save.
      await say(`${C.mag}● LTR_verify_fix${C.reset}`, 300);
      const verify = await mcp.finish(await mcp.call('LTR_verify_fix', { files: [srcRel] }));
      const tests = verify.tests ?? {};
      await say(`  ${C.green}✓ fixed ${(verify.fixed ?? []).length}${C.reset} · still failing ${verify.stillFailingInProject ?? 0}`, 300);
      await say(`  regressions ${(verify.newlyFailing ?? []).length} · ${tests.passed ?? 0} passed`, 900);
      await say(`\n${C.green}${C.bold}Fixed.${C.reset} The discount test passes\nagain and nothing else broke.`, 600);
      await h.waitFor(() => !api.session.isRunning(), { what: 'the rerun', timeout: 60_000 });
      await h.sleep(2500);
      t.check(`ai-fix: ${await stop()} frames`, true);
      await shot('ai-fix-3-verified', CLIP);
      t.check('the fix verified', (verify.fixed ?? []).length > 0);
    } finally {
      mcp?.close();
      cdp.close();
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
