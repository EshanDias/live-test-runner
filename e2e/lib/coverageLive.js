'use strict';
/**
 * The coverage-live checks, shared by the Jest, Vitest and pytest scenarios:
 * coverage stays truthful while the session runs — every number equals what
 * a fresh full run would report now.
 *  - a test removed from a test file lowers its source's coverage
 *  - code that stops calling another file lowers that file's coverage
 *    (single tests rerun by name measure nothing; the background refresh
 *    reruns the test file whole)
 *  - a suite whose tests share a variable reruns whole when its source is saved
 *  - a new source file shows as 0% right away; an edited untested one is recounted
 *  - a deleted source file leaves the totals
 *  - a deleted test file takes its coverage with it
 *
 * `spec` names the fixture's files (relative to the workspace) and edits:
 *   aTest, aSrc, bSrc, cSrc, eSrc, otherTest — the files of the fixture
 *   removeTwo(text)            — a.test without the only test of `two`
 *   stopCallingHelper(text)    — a.src whose `one` no longer calls b's helper
 *   counter: { src, test, tests } (optional) — a suite sharing a variable
 *   newFile: { path, content, more } (optional) — a new source file, then more of it
 *   process (RegExp)           — a test process's command line in the raw output
 *   byName (RegExp)            — a command line that runs tests by name
 *   related (RegExp) (optional) — no trace: saves rerun whole test files through this
 *                                related run (a log line), so no refresh is needed
 */
const fs = require('fs');
const path = require('path');
const h = require('./harness');

/** Debounce, the runs, then the background refresh and its runs. */
async function settle(api) {
  await h.sleep(800);
  await h.settle(api);
  await h.sleep(300);
}

async function run({ api, t, vscode, workspace }, spec) {
  const abs = (f) => path.join(workspace, f);
  const key = (f) => abs(f).replace(/^[A-Z]:/, (m) => m.toLowerCase());
  const name = (f) => path.basename(f);
  const entry = (f) => api.coverageStore.getEntry(key(f));
  const fns = (f) => { const e = entry(f); return !e ? undefined : e.state === 'counted' ? `0/${e.functions}` : `${e.pct.functions.covered}/${e.pct.functions.total}`; };
  const rows = () => api.coverageStore.getFileRows().map((r) => path.basename(r.filePath)).sort();

  await h.waitForDiscovery(api);
  await vscode.commands.executeCommand('liveTestRunner.startTesting');
  await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'source scan', timeout: 60_000 });
  await settle(api);
  t.eq(`full run: ${name(spec.aSrc)} both functions covered`, fns(spec.aSrc), '2/2');
  t.eq(`full run: ${name(spec.bSrc)} helper covered (one calls it)`, fns(spec.bSrc), '1/1');
  t.eq(`full run: ${name(spec.eSrc)} covered by ${name(spec.otherTest)}`, fns(spec.eSrc), '1/1');
  t.eq(`full run: untested ${name(spec.cSrc)} counts as 0%`, fns(spec.cSrc), '0/1');
  t.eq('the totals are final', api.coverageStore.getTotals().updating, undefined);

  // ── A test removed ──
  await h.editAndSave(vscode, abs(spec.aTest), spec.removeTwo);
  await settle(api);
  t.eq(`removing the only test of two() lowers ${name(spec.aSrc)} to 1/2 functions`, fns(spec.aSrc), '1/2');

  // ── one() stops calling helper() ──
  const since = h.isoNow();
  const saveMark = h.rawMark(api);
  await h.editAndSave(vscode, abs(spec.aSrc), spec.stopCallingHelper);
  await settle(api);
  t.eq(`${name(spec.bSrc)} helper is no longer covered once one() stops calling it`, fns(spec.bSrc), '0/1');
  if (spec.related) {
    t.check('the save reran whole test files (related run), never single tests by name',
      h.logsSince(api, since).some((l) => spec.related.test(l)) && !h.rawSince(api, saveMark).some((l) => spec.process.test(l) && spec.byName.test(l)),
      h.logsSince(api, since).join('\n'));
  } else {
    t.check('the save was followed by a coverage refresh', h.logsSince(api, since).some((l) => /Coverage refresh: \d+ test file/.test(l)),
      h.logsSince(api, since).join('\n'));
  }
  t.eq(`${name(spec.aSrc)} is current (not stale) after the refresh`, entry(spec.aSrc)?.state, 'measured');
  t.eq('nothing is left outdated', api.coverageStore.outdatedContributors(), []);
  t.eq('the totals are final again', api.coverageStore.getTotals().updating, undefined);

  // ── A suite whose tests share a variable ──
  if (spec.counter) {
    const mark = h.rawMark(api);
    await h.editAndSave(vscode, abs(spec.counter.src), (s) => s + '\n// touched\n');
    await settle(api);
    // A related run names the source file, not the test file.
    const runs = h.rawSinceWithoutRefresh(api, mark).filter((l) => spec.process.test(l) && l.includes(name(spec.related ? spec.counter.src : spec.counter.test)));
    t.check(`saving ${name(spec.counter.src)} reran ${name(spec.counter.test)} whole (its tests share a variable)`,
      runs.length > 0 && runs.every((l) => !spec.byName.test(l)), runs.join('\n'));
    t.eq(`${name(spec.counter.test)} still passes`, h.statusCounts(api, spec.counter.test), { passed: spec.counter.tests });
  }

  // ── A new source file, then edited ──
  if (spec.newFile) {
    const nf = abs(spec.newFile.path);
    fs.writeFileSync(nf, spec.newFile.content);
    await h.waitFor(() => entry(spec.newFile.path), { what: `${name(nf)} to be counted`, timeout: 30_000 }).catch(() => {});
    await settle(api);
    t.eq('a new source file no test loads shows as 0% right away', fns(spec.newFile.path), '0/1');
    await h.editAndSave(vscode, nf, (s) => s + spec.newFile.more);
    await settle(api);
    t.eq('an edited untested file is recounted from its new content', fns(spec.newFile.path), '0/2');
  }

  // ── A source file deleted ──
  const totalBefore = api.coverageStore.getTotals().functions.total;
  fs.unlinkSync(abs(spec.cSrc));
  await h.waitFor(() => !rows().includes(name(spec.cSrc)), { what: `${name(spec.cSrc)} to leave the coverage rows`, timeout: 30_000 }).catch(() => {});
  t.check('a deleted source file leaves the file list', !rows().includes(name(spec.cSrc)), rows().join(', '));
  t.eq('…and the totals', api.coverageStore.getTotals().functions.total, totalBefore - 1);

  // ── A test file deleted ──
  const deleteSince = h.isoNow();
  fs.unlinkSync(abs(spec.otherTest));
  await h.waitFor(() => fns(spec.eSrc) === '0/1', { what: `${name(spec.eSrc)} coverage to drop`, timeout: 30_000 }).catch(() => {});
  t.check(`deleting the only test file of ${name(spec.eSrc)} drops it to 0%`, fns(spec.eSrc) === '0/1',
    `got ${fns(spec.eSrc)}; contributors ${JSON.stringify(api.coverageStore.contributorsOf(key(spec.eSrc)))}; ` +
    `entry ${JSON.stringify(entry(spec.eSrc))?.slice(0, 300)}\n${h.logsSince(api, deleteSince).filter((l) => /overage|elete|Vitest/.test(l)).join('\n')}`);

  t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  await vscode.commands.executeCommand('liveTestRunner.stopTesting');
}

module.exports = { run };
