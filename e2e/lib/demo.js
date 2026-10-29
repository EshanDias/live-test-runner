'use strict';
/**
 * Not a test: records the README / website demo clips on the demo-* fixtures.
 *
 *   LTR_E2E_CDP_PORT=9333 LTR_E2E_SHOTS_DIR=/tmp/shots node e2e/run.js diag-demo-jest diag-demo-vitest diag-demo-pytest
 *   FFMPEG=/path/to/ffmpeg node scripts/demo-gifs.js /tmp/shots
 *
 * Each framework records the same story, one clip per step (frames +
 * timings, see devtools.js `recorder`):
 *   <fw>-run      Start Testing: the tree fills in live, the Running card, gutter icons
 *   <fw>-save     a source edit + save reruns only the tests that use it (red), then fixed (green)
 *   <fw>-hover    the coverage hover listing the tests that ran a line
 *   <fw>-results  one test's own output in the Results panel
 * plus still screenshots of the hover and the Results panel.
 */
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { devtools, shooter, recorder } = require('./devtools');

const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'window.zoomLevel': 0,
  'editor.fontSize': 14,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'breadcrumbs.enabled': false,
  'workbench.tips.enabled': false,
  'workbench.startupEditor': 'none',
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'liveTestRunner.onSaveDebounceMs': 100,
};

// The window as captured: CSS px. Clips leave out the title bar (y < 36).
const VIEW = { width: 1280, height: 800 };

async function idle(api) {
  await h.sleep(600);
  await h.waitFor(() => api.session._activeRuns === 0 && !api.session.isRunning(), { what: 'runs to finish', timeout: 120_000 });
}

/** Types `text` at the end of the first occurrence of `after`, one character at a time, then saves. */
async function typeAndSave(vscode, editor, after, text) {
  const doc = editor.document;
  const at = doc.getText().indexOf(after);
  if (at < 0) { throw new Error(`"${after}" not found in ${doc.fileName}`); }
  let pos = doc.positionAt(at + after.length);
  editor.selection = new vscode.Selection(pos, pos);
  for (const ch of text) {
    await editor.edit((e) => e.insert(pos, ch));
    pos = pos.translate(0, 1);
    await h.sleep(160);
  }
  await h.sleep(400);
  await doc.save();
}

/** Deletes `count` characters before the end of `after`, one at a time, then saves. */
async function backspaceAndSave(vscode, editor, after, count) {
  const doc = editor.document;
  const end = doc.getText().indexOf(after) + after.length;
  for (let i = 0; i < count; i++) {
    const p = doc.positionAt(end - i);
    await editor.edit((e) => e.delete(new vscode.Range(p.translate(0, -1), p)));
    await h.sleep(160);
  }
  await h.sleep(400);
  await doc.save();
}

/**
 * @param cfg {
 *   fw: 'jest' | 'vitest' | 'pytest',
 *   testFile, sourceFile: workspace-relative paths,
 *   edit: { after, text }  — typed into sourceFile to break a test, then deleted again,
 *   hover: { file, find }  — hover the first line containing `find`,
 *   output: { file, fullName } — the test whose output the Results panel shows,
 * }
 */
async function recordDemo({ api, t, vscode, workspace }, cfg) {
  const port = process.env.LTR_E2E_CDP_PORT;
  const out = process.env.LTR_E2E_SHOTS_DIR;
  if (!port || !out) { t.check('LTR_E2E_CDP_PORT and LTR_E2E_SHOTS_DIR are set', false); return; }
  const cdp = await devtools(port);
  const shot = await shooter(cdp, out, t);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 2, mobile: false });
  const rec = recorder(cdp, out);
  const CLIP = { x: 0, y: 36, width: VIEW.width, height: VIEW.height - 36 };
  const record = (name) => rec(name, CLIP);
  const abs = (rel) => path.join(workspace, rel);
  const open = async (rel, opts = {}) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(abs(rel)), { preview: false, ...opts });
  const original = fs.readFileSync(abs(cfg.sourceFile));
  try {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.view.extension.liveTestRunnerContainer');
    await h.waitForDiscovery(api);
    await open(cfg.testFile);
    await h.sleep(2000);

    // 1. Start: tests stream in, the Running card counts, gutter icons appear.
    let stop = await record(`${cfg.fw}-run`);
    await h.sleep(1200);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
    await idle(api);
    await h.sleep(2000);
    t.check(`${cfg.fw}-run: ${await stop()} frames`, true);

    // 2. Break a source file, save → only its tests rerun (red); undo → green.
    const src = await open(cfg.sourceFile);
    await h.sleep(800);
    stop = await record(`${cfg.fw}-save`);
    await h.sleep(800);
    await typeAndSave(vscode, src, cfg.edit.after, cfg.edit.text);
    await idle(api);
    await h.sleep(2200);
    await backspaceAndSave(vscode, src, cfg.edit.after + cfg.edit.text, cfg.edit.text.length);
    await idle(api);
    await h.sleep(2000);
    t.check(`${cfg.fw}-save: ${await stop()} frames`, true);

    // 3. Coverage hover: which tests ran this line.
    const hov = await open(cfg.hover.file);
    const line = hov.document.getText().split('\n').findIndex((l) => l.includes(cfg.hover.find));
    const col = hov.document.lineAt(line).firstNonWhitespaceCharacterIndex + 2;
    hov.selection = new vscode.Selection(line, col, line, col);
    hov.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await h.sleep(800);
    stop = await record(`${cfg.fw}-hover`);
    await h.sleep(600);
    await vscode.commands.executeCommand('editor.action.showHover');
    await h.sleep(3500);
    t.check(`${cfg.fw}-hover: ${await stop()} frames`, true);
    await shot(`${cfg.fw}-coverage-hover`, CLIP); // after stop(): two captures at once garble the image

    // 4. The Results panel: one test's own output.
    await vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => {});
    const node = h.nodeByName(api, cfg.output.file, cfg.output.fullName);
    const ed = await open(cfg.output.file);
    if (node.line) { ed.revealRange(new vscode.Range(node.line - 1, 0, node.line - 1, 0), vscode.TextEditorRevealType.AtTop); }
    await h.sleep(800);
    stop = await record(`${cfg.fw}-results`);
    await h.sleep(800);
    // ▶ Run on that test (its CodeLens), then its own output in the Results panel.
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName });
    await idle(api);
    await vscode.commands.executeCommand('liveTestRunner.focusResult', node.fileId, node.id);
    await h.sleep(3500);
    t.check(`${cfg.fw}-results: ${await stop()} frames`, true);
    await shot(`${cfg.fw}-results`, CLIP);
  } finally {
    fs.writeFileSync(abs(cfg.sourceFile), original);
    cdp.close();
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
  }
}

module.exports = { recordDemo, SETTINGS, VIEW };
