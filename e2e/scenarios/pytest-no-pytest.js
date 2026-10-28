'use strict';
/**
 * A Python environment without pytest (liveTestRunner.pythonPath names it —
 * the user's own choice is never silently replaced by another Python): Start
 * runs nothing, the log and one notification say which interpreter lacks
 * pytest and how to fix it, and no test is left spinning or marked failed.
 */
const h = require('../lib/harness');

const venvPython = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';

module.exports = {
  workspace: 'fixture:pytest-no-pytest',
  timeoutMs: 3 * 60_000,
  settings: { 'liveTestRunner.pythonPath': venvPython },

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    t.check('discovery still shows the tests (no Python needed)', !!h.nodeByName(api, 'tests/test_a.py', 'test_a'));
    const since = h.isoNow();
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.sleep(1500);
    const logs = h.logsSince(api, since);
    t.check('the log names the interpreter and what is missing',
      logs.some((l) => /No Python environment that can run pytest was found/.test(l) && /pytest is not installed/.test(l)), logs.join('\n'));
    t.check('…and the setting it came from', logs.some((l) => /liveTestRunner\.pythonPath/.test(l)), logs.join('\n'));
    t.eq('no pytest process was started', h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l)), []);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.check('no test marked failed for it', h.nodesWithStatus(api, 'failed').length === 0);
    void workspace;
  },
};
