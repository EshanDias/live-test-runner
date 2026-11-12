'use strict';
/**
 * The coverage-live checks, shared by the Jest, Vitest and pytest scenarios:
 * coverage stays truthful while the session runs — every number equals what
 * a fresh full run would report now.
 *  - a test that fails before it reaches the code lowers coverage; fixed, it rises again
 *  - ▶ Run on a test file, and on one test (by name: measures nothing), keep it equal
 *  - a test removed from a test file lowers its source's coverage
 *  - …also when another test file still covers that source (contributions summed)
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
 *   shared: { src, test, removeSecond(text) } — a source file covered by two test
 *                                files; `test` loses its only test of `second`
 *   newFile: { path, content, more } (optional) — a new source file, then more of it
 *   process (RegExp)           — a test process's command line in the raw output
 *   byName (RegExp)            — a command line that runs tests by name
 *   related (RegExp) (optional) — no trace: saves rerun whole test files through this
 *                                related run (a log line), so no refresh is needed
 *   framework                  — 'jest' | 'vitest' | 'pytest': after every step, every
 *                                file's statements, branches, functions and lines must
 *                                equal the framework's own report of a plain full run
 *                                (h.plainCoverage), not only the functions checked by hand
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
  /** Edit and save, then wait for the save's run to start: settle() alone can return before it does (slow file events on Windows). */
  const edit = async (file, fn) => {
    const since = h.isoNow();
    await h.editAndSave(vscode, file, fn);
    await h.waitFor(() => h.logsSince(api, since).some((l) => /Run #\d+ started/.test(l)), { what: 'the save to start a run', timeout: 15_000 }).catch(() => {});
  };
  const key = (f) => abs(f).replace(/^[A-Z]:/, (m) => m.toLowerCase());
  const name = (f) => path.basename(f);
  const entry = (f) => api.coverageStore.getEntry(key(f));
  const fns = (f) => { const e = entry(f); return !e ? undefined : e.state === 'counted' ? `0/${e.functions}` : `${e.pct.functions.covered}/${e.pct.functions.total}`; };
  const rows = () => api.coverageStore.getFileRows().map((r) => path.basename(r.filePath)).sort();
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const root = real(workspace);
  /** Every number the Coverage tab shows equals the framework's own plain full run now. */
  const matchesPlain = (step) => {
    const want = h.plainCoverage(workspace, spec.framework);
    const metric = ({ covered, total }) => `${covered}/${total}`;
    const show = (pct) => pct && ['statements', 'branches', 'functions', 'lines'].map((m) => `${m[0]} ${metric(pct[m])}`).join(', ');
    const got = new Map(api.coverageStore.getFileRows().map((r) => [path.relative(root, real(r.filePath)).split(path.sep).join('/'), r.pct]));
    const diffs = [];
    for (const f of [...new Set([...want.keys(), ...got.keys()])].sort()) {
      const a = show(got.get(f));
      const b = show(want.get(f));
      if (a !== b) {
        const fp = path.join(root, ...f.split('/'));
        const e = api.coverageStore.getEntry(fp) ?? api.coverageStore.getEntry(abs(f));
        diffs.push(`${f}: extension ${a ?? '(none)'} · plain ${spec.framework} ${b ?? '(none)'} ` +
          `[${e?.state ?? 'no entry'}; covered by ${JSON.stringify((api.coverageStore.contributorsOf(key(f)) || []).map((c) => path.basename(c)))}]`);
      }
    }
    t.check(`${step}: every file's statements, branches, functions and lines equal a plain ${spec.framework} run`, diffs.length === 0, diffs.join('\n'));
  };

  await h.waitForDiscovery(api);
  await vscode.commands.executeCommand('liveTestRunner.startTesting');
  await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'source scan', timeout: 60_000 });
  await settle(api);
  t.eq(`full run: ${name(spec.aSrc)} both functions covered`, fns(spec.aSrc), '2/2');
  t.eq(`full run: ${name(spec.bSrc)} helper covered (one calls it)`, fns(spec.bSrc), '1/1');
  t.eq(`full run: ${name(spec.eSrc)} covered by ${name(spec.otherTest)}`, fns(spec.eSrc), '1/1');
  t.eq(`full run: untested ${name(spec.cSrc)} counts as 0%`, fns(spec.cSrc), '0/1');
  // A file under two spellings (Windows 8.3 short names, symlinks) would show twice, one copy never updated.
  const spellings = new Map();
  for (const r of api.coverageStore.getFileRows()) {
    const k = process.platform === 'win32' ? real(r.filePath).toLowerCase() : real(r.filePath);
    spellings.set(k, [...(spellings.get(k) ?? []), r.filePath]);
  }
  const twice = [...spellings.values()].filter((v) => v.length > 1);
  t.check('one coverage row per file', twice.length === 0,
    `workspace ${workspace}\n` + twice.map((v) => v.map((fp) => `${fp} [${api.coverageStore.getEntry(fp)?.state ?? 'no entry'}; covered by ${JSON.stringify(api.coverageStore.contributorsOf(fp) || [])}]`).join('\n')).join('\n\n'));
  t.eq('the totals are final', api.coverageStore.getTotals().updating, undefined);
  matchesPlain('full run');

  // ── A test fails before it reaches two(), then is fixed ──
  const aTestText = fs.readFileSync(abs(spec.aTest), 'utf8');
  const broken = spec.framework === 'pytest'
    ? aTestText.replace('    assert two(2) == 4', '    assert False, "broken"\n    assert two(2) == 4')
    : aTestText.replace('  expect(two(2)).toBe(4);', "  throw new Error('broken');\n  expect(two(2)).toBe(4);");
  t.check('the fixture has the line to break', broken !== aTestText);
  await edit(abs(spec.aTest), () => broken);
  await settle(api);
  t.eq(`a test failing before it calls two() lowers ${name(spec.aSrc)} to 1/2 functions`, fns(spec.aSrc), '1/2');
  matchesPlain('a test fails before it reaches the code');
  await edit(abs(spec.aTest), () => aTestText);
  await settle(api);
  t.eq(`fixed, it covers two() again: ${name(spec.aSrc)} 2/2 functions`, fns(spec.aSrc), '2/2');
  matchesPlain('the failing test fixed');

  // ── ▶ Run on the test file, then on one test ──
  const aFile = h.fileBySuffix(api, spec.aTest);
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: aFile.fileId });
  await settle(api);
  matchesPlain('▶ Run on a test file');
  const oneTest = h.nodeByName(api, spec.aTest, spec.framework === 'pytest' ? 'test_one' : 'one');
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: oneTest.fileId, nodeId: oneTest.id, fullName: oneTest.fullName });
  await settle(api);
  t.eq(`after ▶ Run on one test, ${name(spec.aSrc)} still 2/2 functions`, fns(spec.aSrc), '2/2');
  matchesPlain('▶ Run on one test');

  // ── A test removed ──
  await edit(abs(spec.aTest), spec.removeTwo);
  await settle(api);
  t.eq(`removing the only test of two() lowers ${name(spec.aSrc)} to 1/2 functions`, fns(spec.aSrc), '1/2');
  matchesPlain('a test removed');

  // ── A test removed from one of two test files that cover a source ──
  t.eq(`full run: ${name(spec.shared.src)} both functions covered (by two test files)`, fns(spec.shared.src), '2/2');
  await edit(abs(spec.shared.test), spec.shared.removeSecond);
  await settle(api);
  t.eq(`removing the only test of second() lowers ${name(spec.shared.src)} to 1/2 functions while the other test file still covers first()`, fns(spec.shared.src), '1/2');
  matchesPlain('a test removed from one of two covering test files');

  // ── one() stops calling helper() ──
  const since = h.isoNow();
  const saveMark = h.rawMark(api);
  await edit(abs(spec.aSrc), spec.stopCallingHelper);
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
  matchesPlain('one() stops calling helper()');

  // ── A suite whose tests share a variable ──
  if (spec.counter) {
    const mark = h.rawMark(api);
    await edit(abs(spec.counter.src), (s) => s + '\n// touched\n');
    await settle(api);
    // A related run names the source file, not the test file.
    const runs = h.rawSinceWithoutRefresh(api, mark).filter((l) => spec.process.test(l) && l.includes(name(spec.related ? spec.counter.src : spec.counter.test)));
    t.check(`saving ${name(spec.counter.src)} reran ${name(spec.counter.test)} whole (its tests share a variable)`,
      runs.length > 0 && runs.every((l) => !spec.byName.test(l)), runs.join('\n'));
    t.eq(`${name(spec.counter.test)} still passes`, h.statusCounts(api, spec.counter.test), { passed: spec.counter.tests });
    matchesPlain('shared-variable suite rerun');
  }

  // ── A new source file, then edited ──
  if (spec.newFile) {
    const nf = abs(spec.newFile.path);
    fs.writeFileSync(nf, spec.newFile.content);
    await h.waitFor(() => entry(spec.newFile.path), { what: `${name(nf)} to be counted`, timeout: 30_000 }).catch(() => {});
    await settle(api);
    t.eq('a new source file no test loads shows as 0% right away', fns(spec.newFile.path), '0/1');
    matchesPlain('new source file');
    const stmtsBefore = entry(spec.newFile.path)?.state === 'counted' ? entry(spec.newFile.path).statements : entry(spec.newFile.path)?.pct.statements.total;
    await edit(nf, (s) => s + spec.newFile.more);
    await settle(api);
    // How many functions an untested file has is the provider's call (Vitest 3's v8: one per file); the plain-run check below has the numbers.
    const stmtsAfter = entry(spec.newFile.path)?.state === 'counted' ? entry(spec.newFile.path).statements : entry(spec.newFile.path)?.pct.statements.total;
    t.check('an edited untested file is recounted from its new content', stmtsAfter > stmtsBefore, `statements ${stmtsBefore} → ${stmtsAfter}`);
    matchesPlain('new source file edited');
  }

  // ── A source file deleted ──
  const totalBefore = api.coverageStore.getTotals().functions.total;
  fs.unlinkSync(abs(spec.cSrc));
  await h.waitFor(() => !rows().includes(name(spec.cSrc)), { what: `${name(spec.cSrc)} to leave the coverage rows`, timeout: 30_000 }).catch(() => {});
  t.check('a deleted source file leaves the file list', !rows().includes(name(spec.cSrc)), rows().join(', '));
  t.eq('…and the totals', api.coverageStore.getTotals().functions.total, totalBefore - 1);
  matchesPlain('source file deleted');

  // ── A test file deleted ──
  const deleteSince = h.isoNow();
  fs.unlinkSync(abs(spec.otherTest));
  await h.waitFor(() => fns(spec.eSrc) === '0/1', { what: `${name(spec.eSrc)} coverage to drop`, timeout: 30_000 }).catch(() => {});
  t.check(`deleting the only test file of ${name(spec.eSrc)} drops it to 0%`, fns(spec.eSrc) === '0/1',
    `got ${fns(spec.eSrc)}; contributors ${JSON.stringify(api.coverageStore.contributorsOf(key(spec.eSrc)))}; ` +
    `entry ${JSON.stringify(entry(spec.eSrc))?.slice(0, 300)}\n${h.logsSince(api, deleteSince).filter((l) => /overage|elete|Vitest/.test(l)).join('\n')}`);

  matchesPlain('test file deleted');
  t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  await vscode.commands.executeCommand('liveTestRunner.stopTesting');
}

module.exports = { run };
