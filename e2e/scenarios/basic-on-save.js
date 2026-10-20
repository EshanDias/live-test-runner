'use strict';
/**
 * Saving files during a session:
 *  - a source file reruns only the tests that executed it (BUG-04)
 *  - a pattern rerun keeps the file's full console output (BUG-10)
 *  - deleting a test file lowers the total (BUG-11)
 *  - the trace maps test files to the store's own keys (BUG-13)
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(800); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(500);
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    t.eq('full run: mixed.test.js', h.statusCounts(api, 'src/mixed.test.js'), { passed: 3 });

    const mixed = h.fileBySuffix(api, 'src/mixed.test.js');
    const fileOutBefore = api.store.getFileOutput(mixed.fileId).lines.map((l) => l.text);
    t.check('full-run file output has all three logs', ['mixed-math', 'mixed-strings', 'mixed-both'].every((s) => fileOutBefore.includes(s)),
      JSON.stringify(fileOutBefore));

    // BUG-13: trace keys are the store's keys.
    const strings = path.join(workspace, 'src', 'strings.js').replace(/^[A-Z]:/, (m) => m.toLowerCase());
    const affected = api.traceStore.getAffectedTestFiles(strings);
    t.check('BUG-13 trace test-file keys exist in the store', affected.length > 0 && affected.every((f) => api.store.getFile(f)),
      JSON.stringify(affected));

    // ── Save strings.js ──
    const since = h.isoNow();
    const mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'src', 'strings.js'), (s) => s + '\n// touched\n');
    await waitIdle(api);
    const logs = h.logsSince(api, since);
    const traceLine = logs.find((l) => /Trace-based rerun for strings\.js/.test(l));
    t.check('BUG-04 save used the trace (not --findRelatedTests)', !!traceLine && !logs.some((l) => /No trace data for strings\.js/.test(l)),
      logs.join('\n'));
    t.info(traceLine || '(no trace line)');

    const raw = h.rawSince(api, mark);
    const commands = raw.filter((l) => /^\[jest#\d+\] > /.test(l));
    t.check('BUG-04 math.test.js was not rerun (it never calls strings.js)', !commands.some((l) => /math\.test\.js/.test(l)), commands.join('\n'));
    const mixedRun = commands.find((l) => /mixed\.test\.js/.test(l));
    t.check('BUG-04 mixed.test.js rerun with a name pattern', !!mixedRun && /--testNamePattern/.test(mixedRun), commands.join('\n'));
    const mixedSummary = h.jestTestSummaries(raw).find((s) => s.passed === 2 && s.skipped === 1);
    t.check('BUG-04 only the 2 strings tests in mixed.test.js ran', !!mixedSummary, JSON.stringify(h.jestTestSummaries(raw)));

    // BUG-10: file output is still the full set.
    const fileOutAfter = api.store.getFileOutput(mixed.fileId).lines.map((l) => l.text);
    t.check('BUG-10 file output still has "mixed-math" after the pattern rerun', fileOutAfter.includes('mixed-math'),
      JSON.stringify(fileOutAfter));
    t.eq('mixed.test.js still all passed', h.statusCounts(api, 'src/mixed.test.js'), { passed: 3 });
    const stringsCov = api.coverageStore.getEntry(strings);
    t.check('coverage of strings.js is not stale after its rerun', stringsCov && stringsCov.state === 'measured',
      JSON.stringify(stringsCov && stringsCov.state));

    // ── Save a source file with no per-test trace (module-level code only) ──
    const configSrc = path.join(workspace, 'src', 'config.js');
    const configKey = configSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase());
    t.check('config.js coverage measured by the full run', api.coverageStore.getEntry(configKey)?.state === 'measured',
      JSON.stringify(api.coverageStore.getEntry(configKey)?.state));
    const since2 = h.isoNow();
    await h.editAndSave(vscode, configSrc, (s) => s + '\n// touched\n');
    await waitIdle(api);
    const logs2 = h.logsSince(api, since2);
    t.check('config.js save used --findRelatedTests (no trace data)', logs2.some((l) => /No trace data for config\.js/.test(l)),
      logs2.join('\n'));
    t.eq('coverage of config.js is not left "stale" after the --findRelatedTests rerun',
      api.coverageStore.getEntry(configKey)?.state, 'measured');
    // Jest --json names the file `name`; reading only testFilePath put these
    // results on a nameless entry, so the tree never updated and the total grew.
    const orphans = [...api.store.nodes.values()].filter((n) => !n.fileId || !api.store.getFile(n.fileId));
    t.eq('--findRelatedTests results land on the test file (no orphan nodes)', orphans.map((n) => n.id), []);
    t.eq('summary.total still equals the test nodes', api.store.getSummary().total,
      h.allNodes(api).filter((n) => n.type === 'test').length);

    // ── A test file created after Start runs when saved ──
    const added = path.join(workspace, 'src', 'added.test.js');
    fs.writeFileSync(added, "test('added after Start', () => { expect(1).toBe(1); });\n");
    await h.waitFor(() => { try { return h.fileBySuffix(api, 'src/added.test.js'); } catch { return undefined; } }, { what: 'added.test.js to be discovered', timeout: 30_000 });
    await h.editAndSave(vscode, added, (s) => s + '\n');
    // Jest is asked for its file list first, so the run starts a little later.
    await h.waitFor(() => h.statusCounts(api, 'src/added.test.js').passed === 1, { what: 'added.test.js to run', timeout: 60_000 })
      .catch(() => {});
    await waitIdle(api);
    t.eq('a test file created after Start runs on save', h.statusCounts(api, 'src/added.test.js'), { passed: 1 });

    // ── Delete a test file during the session ──
    const totalBefore = api.store.getSummary().total;
    const mixedTests = h.statusCounts(api, 'src/mixed.test.js').passed;
    fs.unlinkSync(mixed.fileId);
    await h.waitFor(() => !api.store.getFile(mixed.fileId), { what: 'mixed.test.js to leave the store', timeout: 30_000 });
    t.eq('BUG-11 total drops by the deleted file\'s tests', api.store.getSummary().total, totalBefore - mixedTests);
    const testNodes = h.allNodes(api).filter((n) => n.type === 'test').length;
    t.eq('BUG-11 total still equals the test nodes', api.store.getSummary().total, testNodes);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
