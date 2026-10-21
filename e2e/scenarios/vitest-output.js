'use strict';
/**
 * Console output on a Vitest project: Vitest says which test or suite printed
 * each line, so every test that ran shows exactly its own output (better
 * than Jest's file-level output), a suite shows its hooks' output, the file
 * shows everything, and Vitest's own reporter output reaches Test Output.
 */
const h = require('../lib/harness');

const FILE = 'src/logs.test.js';
const texts = (o) => o.lines.map((l) => l.text);

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const raw = h.rawSince(api, mark);

    const file = h.fileBySuffix(api, FILE);
    t.eq('file output has every line', texts(api.store.getFileOutput(file.fileId)).sort(),
      ['module log', 'one log', 'setup log', 'two warning']);
    const node = (name) => h.nodeByName(api, FILE, name);
    t.eq('test "one" shows only its own line', texts(api.store.getNodeOutput(node('logs one').id)), ['one log']);
    t.eq('test "two" shows only its own line', texts(api.store.getNodeOutput(node('logs two').id)), ['two warning']);
    const quiet = api.store.getNodeOutput(node('logs quiet').id);
    t.check('a quiet test that ran has empty output (not a placeholder)', quiet.lines.length === 0 && quiet.capturedAt > 0, JSON.stringify(quiet));
    t.eq('the suite shows its beforeAll output', texts(api.store.getNodeOutput(node('logs').id)), ['setup log']);
    t.check('the math test shows its console.log', texts(api.store.getNodeOutput(h.nodeByName(api, 'src/math.test.js', 'Math utils adds numbers').id)).includes('adding ✓ ünïcödé'));

    t.check("Vitest's own reporter output reaches Test Output", raw.some((l) => /^\[vitest#\d+\] .*Test Files/.test(l)),
      raw.filter((l) => /vitest#/.test(l)).slice(-10).join('\n'));

    // Rerun one test alone: its output stays its own; the file keeps all lines.
    const one = node('logs one');
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: one.fileId, nodeId: one.id, fullName: one.fullName });
    t.eq('after rerunning "one": still only its line', texts(api.store.getNodeOutput(one.id)), ['one log']);
    t.eq('…and the file output is unchanged', texts(api.store.getFileOutput(file.fileId)).sort(),
      ['module log', 'one log', 'setup log', 'two warning']);
    t.eq('…and "two" keeps its own output', texts(api.store.getNodeOutput(node('logs two').id)), ['two warning']);
  },
};
