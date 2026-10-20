'use strict';
/**
 * jest.config.mjs exporting an async function, with an alias that exists only
 * in that config (BUG-07).
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:esm-fn-config',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);

    t.eq('BUG-07 format.test.js passes (async .mjs config loaded)', h.statusCounts(api, 'lib/format.test.js'), { passed: 1 });
    const bad = logs.filter((l) => /returned no results|falling back to plain Jest|failed to run/.test(l));
    t.check('BUG-07 no fallback to plain Jest', bad.length === 0, bad.join('\n'));
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
