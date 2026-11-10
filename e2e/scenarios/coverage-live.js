'use strict';
/**
 * Coverage stays truthful while the session runs (Jest): every number equals
 * what a fresh full run would report now.
 *  - a test removed from a test file lowers its source's coverage
 *  - code that stops calling another file lowers that file's coverage
 *    (single tests rerun by name measure nothing; the background refresh
 *    reruns the test file whole)
 *  - a new source file shows as 0% right away; an edited untested one is recounted
 *  - a deleted source file leaves the totals
 *  - a deleted test file takes its coverage with it
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

/** Debounce, the runs, then the background refresh (750 ms after the last run) and its runs. */
async function settle(api) {
  await h.sleep(800);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(1500);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'coverage refresh to finish', timeout: 120_000 });
  await h.sleep(300);
}

module.exports = {
  workspace: 'fixture:coverage-live',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const src = (f) => path.join(workspace, 'src', f).replace(/^[A-Z]:/, (m) => m.toLowerCase());
    const entry = (f) => api.coverageStore.getEntry(src(f));
    const fns = (f) => { const e = entry(f); return !e ? undefined : e.state === 'counted' ? `0/${e.functions}` : `${e.pct.functions.covered}/${e.pct.functions.total}`; };
    const rows = () => api.coverageStore.getFileRows().map((r) => path.basename(r.filePath)).sort();

    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'source scan', timeout: 60_000 });
    await settle(api);
    t.eq('full run: a.js both functions covered', fns('a.js'), '2/2');
    t.eq('full run: b.js helper covered (a.one calls it)', fns('b.js'), '1/1');
    t.eq('full run: e.js covered by other.test.js', fns('e.js'), '1/1');
    t.eq('full run: untested c.js counts as 0%', fns('c.js'), '0/1');
    t.eq('the totals are final', api.coverageStore.getTotals().updating, undefined);

    // ── A test removed from a.test.js ──
    const aTest = path.join(workspace, 'src', 'a.test.js');
    await h.editAndSave(vscode, aTest, (s) => s.replace(/test\('two'[\s\S]*?\n\}\);\n/, ''));
    await settle(api);
    t.eq('removing the only test of a.two lowers a.js to 1/2 functions', fns('a.js'), '1/2');

    // ── a.one stops calling b.helper ──
    const aSrc = path.join(workspace, 'src', 'a.js');
    const since = h.isoNow();
    await h.editAndSave(vscode, aSrc, (s) => s.replace('return helper(x);', 'return x + 1;'));
    await settle(api);
    t.eq('b.js helper is no longer covered once a.js stops calling it', fns('b.js'), '0/1');
    t.check('the save was followed by a coverage refresh', h.logsSince(api, since).some((l) => /Coverage refresh: \d+ test file/.test(l)),
      h.logsSince(api, since).join('\n'));
    t.eq('a.js is current (not stale) after the refresh', entry('a.js')?.state, 'measured');
    t.eq('nothing is left outdated', api.coverageStore.outdatedContributors(), []);
    t.eq('the totals are final again', api.coverageStore.getTotals().updating, undefined);

    // ── A new source file ──
    const dSrc = path.join(workspace, 'src', 'd.js');
    fs.writeFileSync(dSrc, "function brandNew() {\n  return 'd';\n}\n\nmodule.exports = { brandNew };\n");
    await h.waitFor(() => entry('d.js'), { what: 'd.js to be counted', timeout: 30_000 }).catch(() => {});
    await settle(api);
    t.eq('a new source file no test loads shows as 0% right away', fns('d.js'), '0/1');

    // ── An untested file edited: counted again ──
    await h.editAndSave(vscode, dSrc, (s) => s + "\nfunction another() {\n  return 'dd';\n}\n\nmodule.exports.another = another;\n");
    await settle(api);
    t.eq('an edited untested file is recounted from its new content', fns('d.js'), '0/2');

    // ── A source file deleted ──
    const totalBefore = api.coverageStore.getTotals().functions.total;
    fs.unlinkSync(path.join(workspace, 'src', 'c.js'));
    await h.waitFor(() => !rows().includes('c.js'), { what: 'c.js to leave the coverage rows', timeout: 30_000 }).catch(() => {});
    t.check('a deleted source file leaves the file list', !rows().includes('c.js'), rows().join(', '));
    t.eq('…and the totals', api.coverageStore.getTotals().functions.total, totalBefore - 1);

    // ── A test file deleted ──
    fs.unlinkSync(path.join(workspace, 'src', 'other.test.js'));
    await h.waitFor(() => fns('e.js') === '0/1', { what: 'e.js coverage to drop', timeout: 30_000 }).catch(() => {});
    t.eq('deleting the only test file of e.js drops it to 0%', fns('e.js'), '0/1');

    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
  },
};
