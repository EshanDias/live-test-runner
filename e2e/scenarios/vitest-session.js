'use strict';
/**
 * The session with Vitest: nothing runs on save before Start (session
 * guard); during a session a saved test file reruns alone, a saved source
 * file reruns its related tests (`vitest related` — no trace for Vitest
 * yet), ▶ Run on one test runs just that test; after Stop saves run nothing.
 */
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}
const vitestCmds = (lines) => lines.filter((l) => /^\[vitest#\d+\] > /.test(l));

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const mathTest = path.join(workspace, 'src', 'math.test.js');

    // ── Session guard: no session, no background runs ──
    let mark = h.rawMark(api);
    await h.editAndSave(vscode, mathTest, (s) => s + '\n// before start\n');
    await h.sleep(2000);
    t.eq('save before Start runs nothing', vitestCmds(h.rawSince(api, mark)), []);

    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    t.eq('full run: math.test.js', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });

    // ── Save a test file: only that file reruns ──
    mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'src', 'strings.test.ts'), (s) => s + '\n// touched\n');
    await waitIdle(api);
    let cmds = vitestCmds(h.rawSince(api, mark));
    t.check('saved strings.test.ts reruns it', cmds.some((l) => / run .*strings\.test\.ts/.test(l)), cmds.join('\n'));
    t.check('…and nothing else', !cmds.some((l) => /math\.test\.js|top-level\.spec\.js/.test(l)), cmds.join('\n'));
    t.eq('strings.test.ts results after the rerun', h.statusCounts(api, 'src/strings.test.ts'), { passed: 1, failed: 1 });

    // ── Save a source file: its related tests rerun ──
    mark = h.rawMark(api);
    const since = h.isoNow();
    await h.editAndSave(vscode, path.join(workspace, 'src', 'math.js'), (s) => s + '\n// touched\n');
    await waitIdle(api);
    cmds = vitestCmds(h.rawSince(api, mark));
    const logs = h.logsSince(api, since);
    t.check('saved math.js runs `vitest related` (no trace for Vitest)', cmds.some((l) => / related .*math\.js/.test(l)), cmds.join('\n'));
    t.check('the log names vitest related', logs.some((l) => /using vitest related/.test(l)), logs.join('\n'));
    t.eq('math.test.js still passes', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });

    // ── ▶ Run on one test ──
    const one = h.nodeByName(api, 'src/math.test.js', 'Math utils divide throws on zero');
    mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: one.type, fileId: one.fileId, nodeId: one.id, fullName: one.fullName });
    await waitIdle(api);
    cmds = vitestCmds(h.rawSince(api, mark));
    t.check('▶ Run passes a -t name pattern for that test', cmds.some((l) => / -t /.test(l) && /throws/.test(l)), cmds.join('\n'));
    t.eq('the test is still passed', h.nodeByName(api, 'src/math.test.js', 'Math utils divide throws on zero').status, 'passed');
    t.eq('its siblings keep their results', h.nodeByName(api, 'src/math.test.js', 'Math utils adds numbers').status, 'passed');

    // ── After Stop, saves run nothing ──
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    mark = h.rawMark(api);
    await h.editAndSave(vscode, mathTest, (s) => s + '\n// after stop\n');
    await h.sleep(2000);
    t.eq('save after Stop runs nothing', vitestCmds(h.rawSince(api, mark)), []);
  },
};
