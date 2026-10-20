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
