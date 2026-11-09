'use strict';
/**
 * A failed test's message on the line where it failed: the assertion in the
 * test, and the line of the source file an error was thrown from. The hover
 * has Show diff (expected / received side by side) and Dismiss; an edited
 * line shows nothing; the setting turns it off.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const SOURCE = [
  'function parse(s) {',
  '  return s.value.trim();',
  '}',
  'module.exports = { parse };',
  '',
].join('\n');

const TEST = [
  "const { parse } = require('./parse');",
  "test('compares numbers', () => {",
  '  expect(1 + 1).toBe(3);',
  '});',
  "test('compares objects', () => {",
  '  expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 3 });',
  '});',
  "test('throws in source', () => {",
  '  parse({});',
  '});',
  "test('passes', () => { expect(1).toBe(1); });",
  '',
].join('\n');

const lines = (marks) => [...new Set(marks.map((m) => m.line))].sort((a, b) => a - b);

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const testFile = path.join(workspace, 'src', 'failing.test.js');
    const sourceFile = path.join(workspace, 'src', 'parse.js');
    fs.writeFileSync(sourceFile, SOURCE);
    fs.writeFileSync(testFile, TEST);
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('failing.test.js')), { what: 'the new test file', timeout: 30_000 });
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: testFile, nodeId: testFile });
    const fd = api.failureDecorations;

    const testDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
    await vscode.window.showTextDocument(testDoc);
    const marks = fd.marks(testDoc);
    t.eq('the test file shows each failure on its failing line', lines(marks), [3, 6, 9]);
    t.eq('a single-value comparison says what differs', marks.find((m) => m.line === 3)?.failure.summary, 'Expected 3, received 2');

    const sourceDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(sourceFile));
    const sourceMarks = fd.marks(sourceDoc);
    t.eq('the source file shows the error on the line it was thrown from', lines(sourceMarks), [2]);
    t.check('with the error itself', /^TypeError: /.test(sourceMarks[0]?.failure.summary ?? ''), sourceMarks[0]?.failure.summary);

    // Hover: the whole message, Show diff, Dismiss.
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', testDoc.uri, new vscode.Position(5, 4));
    const hoverText = (hovers || []).flatMap((x) => x.contents).map((c) => c.value ?? String(c)).join('\n');
    t.check('the hover has the message, Show diff and Dismiss',
      hoverText.includes('toEqual') && hoverText.includes('Show diff') && hoverText.includes('Dismiss'), hoverText.slice(0, 400));

    const objects = marks.find((m) => m.line === 6);
    await vscode.commands.executeCommand('liveTestRunner.showFailureDiff', objects.nodeId, objects.testName);
    await h.waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff, { what: 'the diff editor', timeout: 10_000 });
    const diff = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    const [expected, received] = await Promise.all([diff.original, diff.modified].map((u) => vscode.workspace.openTextDocument(u)));
    t.check('Show diff opens expected and received side by side',
      /"b": 3/.test(expected.getText()) && /"b": 2/.test(received.getText()), `${expected.getText()}\n---\n${received.getText()}`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    const numbers = marks.find((m) => m.line === 3);
    await vscode.commands.executeCommand('liveTestRunner.dismissFailure', numbers.nodeId);
    t.eq('Dismiss hides that failure', lines(fd.marks(testDoc)), [6, 9]);

    // An edited line shows nothing (the message may no longer be about it).
    const editor = await vscode.window.showTextDocument(testDoc);
    await editor.edit((e) => e.insert(new vscode.Position(5, 2), '/* edited */ '));
    t.eq('an edited line shows nothing', lines(fd.marks(testDoc)), [9]);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    t.eq('back as it was, the failure shows again', lines(fd.marks(testDoc)), [6, 9]);

    // The test runs again: a dismissed failure comes back.
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: testFile, nodeId: testFile });
    t.eq('after a rerun the dismissed failure shows again', lines(fd.marks(testDoc)), [3, 6, 9]);

    await vscode.workspace.getConfiguration('liveTestRunner').update('showFailuresInEditor', false, vscode.ConfigurationTarget.Global);
    t.eq('showFailuresInEditor off: nothing shown', fd.marks(testDoc).length + fd.marks(sourceDoc).length, 0);
    await vscode.workspace.getConfiguration('liveTestRunner').update('showFailuresInEditor', undefined, vscode.ConfigurationTarget.Global);
  },
};
