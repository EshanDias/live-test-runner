'use strict';
/**
 * Coverage bars while editing:
 *  - a statement over several lines has a bar on each of them
 *  - unsaved edits move the bars with their lines; an edited or new line has no bar
 *  - the coverage hover follows the same lines
 *  - Hide / Show Coverage in Editor clears and restores bars and hover
 *  - reverting the edits puts every bar back where it was
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());
const sorted = (a) => [...(a || [])].sort((x, y) => x - y);

async function hoverText(vscode, doc, line) {
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, 2));
  return (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}
const isCoverageHover = (text) => /Covered by|Not covered|Coverage data is stale/.test(text);

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const deco = api.coverageDecorations;
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');

    const mathPath = path.join(workspace, 'src', 'math.js');
    const original = fs.readFileSync(mathPath, 'utf8');
    await h.waitFor(() => api.coverageStore.getEntry(key(mathPath))?.state === 'measured', { what: 'src/math.js coverage' });

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(mathPath));
    const editor = await vscode.window.showTextDocument(doc);
    const drawn = () => deco.drawnLines(doc.uri.fsPath);
    await h.waitFor(() => drawn()?.covered.length > 0, { what: 'bars drawn on src/math.js' });

    const before = { covered: sorted(drawn().covered), partial: sorted(drawn().partial), uncovered: sorted(drawn().uncovered) };
    t.check('bars on math.js: "return a + b" (line 2) is covered', before.covered.includes(1), JSON.stringify(before));
    t.check('…and blank lines have none (no grey filler bars any more)', !before.covered.includes(3) && !before.uncovered.includes(3), JSON.stringify(before));
    t.check('a statement over several lines (module.exports = { … }, lines 17–21) has a bar on each line',
      [16, 17, 18, 19, 20].every((l) => before.covered.includes(l)), JSON.stringify(before));
    t.check('…and its hover on a later line says covered', /Covered/.test(await hoverText(vscode, doc, 18)), await hoverText(vscode, doc, 18));

    // 1. Insert a line at the top without saving: every bar moves down one line.
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// note\n'));
    await h.waitFor(() => drawn()?.covered.includes(2), { what: 'bars to follow the inserted line', timeout: 5_000 });
    const shifted = (a) => a.map((l) => l + 1);
    t.eq('after inserting a line: covered bars moved down by one', sorted(drawn().covered), shifted(before.covered));
    t.eq('…uncovered bars too', sorted(drawn().uncovered), shifted(before.uncovered));
    t.eq('…partial bars too', sorted(drawn().partial), shifted(before.partial));
    t.check('the inserted line has no bar', ![...drawn().covered, ...drawn().uncovered, ...drawn().partial].includes(0));

    const movedHover = await hoverText(vscode, doc, 2);
    t.check('hover on the moved "return a + b" line still lists its tests', /Covered by/.test(movedHover), movedHover);
    t.check('no coverage hover on the inserted line', !isCoverageHover(await hoverText(vscode, doc, 0)));

    // 2. Edit a covered line: it loses its bar, the others stay.
    const ln = doc.lineAt(2);
    await editor.edit((e) => e.replace(ln.range, '  return a + b + 0;'));
    await h.waitFor(() => !drawn()?.covered.includes(2), { what: 'the edited line to lose its bar', timeout: 5_000 });
    t.eq('after editing line 3: only that line lost its bar', sorted(drawn().covered), shifted(before.covered).filter((l) => l !== 2));
    t.check('no coverage hover on the edited line', !isCoverageHover(await hoverText(vscode, doc, 2)));

    // 3. Hide / Show Coverage in Editor.
    await vscode.commands.executeCommand('liveTestRunner.hideCoverageInEditor');
    await h.waitFor(() => drawn() === undefined, { what: 'bars to clear when hidden', timeout: 5_000 });
    t.check('hidden: no bars', drawn() === undefined);
    t.check('hidden: no coverage hover', !isCoverageHover(await hoverText(vscode, doc, 6)));
    await vscode.commands.executeCommand('liveTestRunner.showCoverageInEditor');
    await h.waitFor(() => drawn()?.covered.length > 0, { what: 'bars back when shown', timeout: 5_000 });
    t.check('shown again: bars are back', drawn()?.covered.length > 0);

    // 4. Most of the file rewritten: no bars at all until it is saved.
    const all = new vscode.Range(0, 0, doc.lineCount, 0);
    await editor.edit((e) => e.replace(all, 'const rewritten = true;\n\nfunction add(a, b) {\n  return a + b;\n}\n'));
    await h.waitFor(() => (drawn()?.covered.length ?? 0) + (drawn()?.uncovered.length ?? 0) === 0, { what: 'bars to clear on a rewrite', timeout: 5_000 });
    t.check('most of the file rewritten: no bars at all', true);

    // 5. Revert: every bar is back on its original line; nothing was saved or rerun.
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await h.waitFor(() => sorted(drawn()?.covered).join() === before.covered.join(), { what: 'bars back after revert', timeout: 5_000 });
    t.eq('after revert: covered bars on their original lines', sorted(drawn().covered), before.covered);
    t.eq('…uncovered too', sorted(drawn().uncovered), before.uncovered);
    t.check('the file on disk was never changed', fs.readFileSync(mathPath, 'utf8') === original);

    // 6. The sidebar's gear opens the extension's settings.
    await vscode.commands.executeCommand('liveTestRunner.openSettings');
    await h.sleep(1000);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    t.check('Open Settings shows the Settings editor', /settings/i.test(tab?.label ?? ''), tab?.label);
  },
};
