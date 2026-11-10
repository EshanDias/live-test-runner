'use strict';
/**
 * Update snapshot (Jest): offered on a snapshot failure, never without a yes
 * in a dialog that names the file, then Jest rewrites only that test's
 * snapshot — the other snapshots of the file (and an obsolete one) stay.
 * Also used for Vitest: LTR_SNAPSHOT_FRAMEWORK=vitest (vitest-snapshot-update).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

function files(framework) {
  const imp = framework === 'vitest' ? "import { expect, test } from 'vitest';\n" : '';
  const test = [
    imp + "test('renders a', () => { expect({ a: 1 }).toMatchSnapshot(); });",
    "test('renders b', () => { expect('b').toMatchSnapshot(); });",
    "test('inline', () => { expect(1 + 1).toMatchInlineSnapshot(`3`); });",
    '',
  ].join('\n');
  const header = framework === 'vitest'
    ? '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html'
    : '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing';
  const snap = [
    header, '',
    'exports[`gone 1`] = `"no test uses this one"`;', '',
    'exports[`renders a 1`] = `', '{', '  "a": 2,', '}', '`;', '',
    'exports[`renders b 1`] = `"b"`;', '',
  ].join('\n');
  return { test, snap };
}

async function scenario({ api, t, vscode, workspace }, framework) {
  const ext = framework === 'vitest' ? 'snap.test.ts' : 'snap.test.js';
  const testFile = path.join(workspace, 'src', ext);
  const snapFile = path.join(workspace, 'src', '__snapshots__', `${ext}.snap`);
  const { test, snap } = files(framework);
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  fs.writeFileSync(testFile, test);
  fs.writeFileSync(snapFile, snap);
  await h.waitForDiscovery(api);
  await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith(ext)), { what: 'the new test file', timeout: 30_000 });
  // The store's own key, as the UI passes it: on Windows it can differ from `testFile` in the drive
  // letter's case (VS Code lowercases it), and a command given the other spelling files its
  // results under a second entry.
  const fileId = h.fileBySuffix(api, `src/${ext}`).fileId;
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId, nodeId: fileId });

  const a = h.nodeByName(api, `src/${ext}`, 'renders a');
  t.eq('the changed snapshot fails, the matching one passes', [a?.status, h.nodeByName(api, `src/${ext}`, 'renders b')?.status], ['failed', 'passed']);

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
  const mark = api.failureDecorations.marks(doc).find((m) => m.nodeId === a.id);
  t.eq('it is seen as a snapshot failure', mark?.failure.snapshot, 'file');
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(mark.line - 1, 10));
  const hoverText = (hovers || []).flatMap((x) => x.contents).map((c) => c.value ?? String(c)).join('\n');
  t.check('the hover offers Update snapshot', hoverText.includes('Update snapshot'), hoverText.slice(0, 300));

  // "No" changes nothing.
  const before = fs.readFileSync(snapFile, 'utf8');
  const asked = [];
  api.setSnapshotDialogAnswerForE2E((message, detail) => { asked.push({ message, detail }); return false; });
  const declined = await vscode.commands.executeCommand('liveTestRunner.updateSnapshot', fileId, a.id);
  t.eq('declined: nothing written', [declined, fs.readFileSync(snapFile, 'utf8')], [false, before]);
  t.check('the dialog names the test and the file that will change',
    asked[0]?.message.includes('renders a') && asked[0]?.detail.includes(`${ext}.snap`) && /changes a file in your project/.test(asked[0]?.detail)
      && /no test uses any more are removed/.test(asked[0]?.detail), JSON.stringify(asked[0]));

  // "Yes": the framework rewrites this test's snapshot only.
  api.setSnapshotDialogAnswerForE2E(() => true);
  const updated = await vscode.commands.executeCommand('liveTestRunner.updateSnapshot', fileId, a.id);
  api.setSnapshotDialogAnswerForE2E(undefined);
  const after = fs.readFileSync(snapFile, 'utf8');
  t.check('confirmed: the snapshot now holds the new value', updated === true && /"a": 1/.test(after) && !/"a": 2/.test(after), after);
  t.check('the other test\'s snapshot stays; the unused one is removed (as -u does, and as the dialog said)',
    /renders b 1/.test(after) && !/no test uses this one/.test(after), after);
  t.eq('the test passes now', h.nodeByName(api, `src/${ext}`, 'renders a')?.status, 'passed');
  t.eq('the inline snapshot was not touched', fs.readFileSync(testFile, 'utf8'), test);

  // Inline: the test file itself; refused while it has unsaved changes.
  const inline = h.nodeByName(api, `src/${ext}`, 'inline');
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// unsaved\n'));
  api.setSnapshotDialogAnswerForE2E(() => true);
  const refused = await vscode.commands.executeCommand('liveTestRunner.updateSnapshot', fileId, inline.id);
  t.eq('an inline snapshot is not updated while the test file has unsaved changes', [refused, fs.readFileSync(testFile, 'utf8')], [false, test]);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  const inlineAsked = [];
  api.setSnapshotDialogAnswerForE2E((message, detail) => { inlineAsked.push(detail); return true; });
  await vscode.commands.executeCommand('liveTestRunner.updateSnapshot', fileId, inline.id);
  api.setSnapshotDialogAnswerForE2E(undefined);
  t.check('for an inline snapshot the dialog says the test file itself changes', /inline snapshot in .*the test file itself/.test(inlineAsked[0] ?? ''), inlineAsked[0]);
  t.check('the inline snapshot is rewritten in the test file', /toMatchInlineSnapshot\(`2`\)/.test(fs.readFileSync(testFile, 'utf8')), fs.readFileSync(testFile, 'utf8'));
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,
  run: (ctx) => scenario(ctx, 'jest'),
  scenario,
};
