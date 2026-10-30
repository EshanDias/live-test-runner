'use strict';
/**
 * Saving files in a pytest project during a session: a saved test file
 * reruns (only that file, its new test appears with its result); a saved
 * pytest config restarts the session; saving a non-Python file starts nothing.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function idle(api) {
  await h.sleep(1500);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
}

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,
  settings: { 'liveTestRunner.onSaveDebounceMs': 100 },

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const file = path.join(workspace, 'tests', 'test_unittest_style.py');

    let mark = h.rawMark(api);
    await h.editAndSave(vscode, file, (text) => text + '\n    def test_added(self):\n        self.assertEqual(1, 1)\n');
    await idle(api);
    let cmds = h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
    t.check('saving a test file reruns exactly that file', cmds.length === 1 && /test_unittest_style\.py/.test(cmds[0]) && !/test_cart\.py/.test(cmds[0]), cmds.join('\n'));
    t.eq('the new test shows with its result', h.nodeByName(api, 'tests/test_unittest_style.py', 'DiscountTests test_added')?.status, 'passed');

    mark = h.rawMark(api);
    fs.writeFileSync(path.join(workspace, 'notes.md'), '# notes\n');
    await h.editAndSave(vscode, path.join(workspace, 'notes.md'), (text) => text + 'more\n');
    await h.sleep(1500);
    t.eq('saving a Markdown file starts nothing', h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > /.test(l)), []);

    const since = h.isoNow();
    mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'pyproject.toml'), (text) => text + '\n');
    await idle(api);
    const logs = h.logsSince(api, since);
    t.check('saving the pytest config restarts the session', logs.some((l) => /pytest config changed, restarting the session/.test(l)), logs.join('\n'));
    t.eq('…and every test reruns', h.sortedCounts(api, 'tests/test_cart.py'), { failed: 2, passed: 9, skipped: 2 });
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
