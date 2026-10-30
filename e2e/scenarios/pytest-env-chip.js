'use strict';
/**
 * The Explorer's Python environment chip on a pytest project: shown before
 * Start (the interpreter is probed quietly when the project is shown) with
 * the version, the environment and pytest's version; the tooltip has the
 * path and where it was found; it stays the same after a run.
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 3 * 60_000,

  async run({ api, t, vscode }) {
    const chip = () => api.explorerView._pythonEnv;
    await h.waitFor(() => chip() && !/detecting/.test(chip().text), { what: 'the Python environment chip', timeout: 30_000 });
    const before = chip();
    t.check('chip before Start: Python <version> · .venv · pytest 9.1.1', /^Python 3\.\d+\.\d+ · \.venv · pytest 9\.1\.1$/.test(before.text), before.text);
    t.eq('…not amber', before.warn, false);
    t.check('tooltip: the .venv interpreter and where it was found', /[\\/]\.venv[\\/]/.test(before.tooltip) && /Found via: \.venv/.test(before.tooltip) && /coverage 7\.17\.0/.test(before.tooltip), before.tooltip);

    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the run', timeout: 120_000 });
    t.eq('chip after the run: unchanged', chip().text, before.text);
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
  },
};
