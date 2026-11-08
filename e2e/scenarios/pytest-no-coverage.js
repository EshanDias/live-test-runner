'use strict';
/**
 * A pytest project whose environment has no `coverage` package:
 * the tests run as usual, nothing is measured, and the Coverage
 * tab is told why and what to install (CoverageTotals.off) instead of a
 * silent empty table.
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:pytest-no-coverage',
  timeoutMs: 3 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the run', timeout: 120_000 });
    const s = api.store.getSummary();
    t.eq('the tests still run', { total: s.total, passed: s.passed, failed: s.failed }, { total: 2, passed: 2, failed: 0 });
    const measured = [...api.coverageStore.getAllEntries()].filter(([, e]) => e.state === 'measured');
    t.eq('nothing is measured', measured.length, 0);
    const off = api.coverageStore.getTotals().off ?? [];
    t.check('the Coverage tab is told why: install the coverage package', off.length === 1 && /pytest: install the coverage package/.test(off[0]), JSON.stringify(off));

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    t.check('after Stop the note is gone with the coverage data', !api.coverageStore.getTotals().off, JSON.stringify(api.coverageStore.getTotals().off));
  },
};
