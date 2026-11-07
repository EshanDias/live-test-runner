'use strict';
/**
 * On Start, the test files open in the editor run first, in a batch of their
 * own: the first Jest process runs only the open file,
 * and the full run still covers every file once.
 */
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const open = path.join(workspace, 'src', 'table.test.js');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(open)));

    const rec = h.recordEvents(api);
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const testArgs = (l) => (l.match(/[^\s"]+\.test\.[cm]?[jt]s/g) || []).map((f) => path.basename(f));
    // Runs only (the listing before them names no test file).
    const cmds = h.rawSince(api, mark).filter((l) => /^\[jest#\d+\] > /.test(l) && testArgs(l).length > 0);
    t.check('the first Jest process runs only the open file', cmds.length > 1 && testArgs(cmds[0]).join() === 'table.test.js', cmds.map(testArgs).join('\n'));
    const results = rec.of('file-result').map((e) => e.file);
    t.eq('…and every test file still ran once', results.filter((f) => f === 'table.test.js').length, 1);
    t.check('…all files have results', api.store.getAllFiles().every((f) => f.status !== 'pending' && f.status !== 'running'),
      JSON.stringify(api.store.getAllFiles().filter((f) => f.status === 'pending' || f.status === 'running').map((f) => f.filePath)));
    rec.stop();
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
  },
};
