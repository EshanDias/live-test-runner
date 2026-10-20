'use strict';
/**
 * Full run on the basic fixture: everything that must be true once "Start
 * Testing" completes.
 */
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const rec = h.recordEvents(api);
    const since = h.isoNow();

    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.sleep(500); // let trailing observer notifications land
    const logs = h.logsSince(api, since);
    t.info(`events: ${rec.events.map((e) => e.type).join(' ')}`.slice(0, 400));

    // BUG-23: nothing may still spin once the run is over.
    const spinning = h.nodesWithStatus(api, 'running');
    t.check('BUG-23 no test left "running" after the full run', spinning.length === 0,
      spinning.map((n) => n.id).join('\n'));

    // BUG-15: exactly one run-finished, and nothing running at that moment.
    const finished = rec.of('run-finished');
    t.eq('BUG-15 one run-finished event for one Start', finished.length, 1);
    t.check('BUG-15 run-finished only after every test settled', finished.every((e) => e.running === 0),
      JSON.stringify(finished));

    // Results
    t.eq('math.test.js results', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('strings.test.js results', h.statusCounts(api, 'src/strings.test.js'), { passed: 4 });
    // Nested optional chains used to crash instrumentation of invoice.js.
    t.eq('invoice.test.js results (nested ?. instrumented)', h.statusCounts(api, 'src/invoice.test.js'), { passed: 2 });
    // Real-project lessons (see the comments in each fixture file).
    t.eq('BUG-25/26 it.each $var table + duplicate names: all 4 results kept', h.statusCounts(api, 'src/table.test.js'), { passed: 4 });
    t.eq('BUG-07 --resetMocks from the test script is honoured', h.statusCounts(api, 'src/mocks.test.js'), { passed: 2 });
    t.eq('BUG-27 a test that mocks fs passes', h.statusCounts(api, 'src/fsmock.test.js'), { passed: 1 });
    const fsErrors = logs.filter((l) => /could not write|is not a function/.test(l));
    t.check('BUG-27 coverage / trace writing unaffected by jest.mock(\'fs\')', fsErrors.length === 0, fsErrors.join('\n'));
    h.checkMatchesPlainJest(api, t, workspace);

    // BUG-24 #1: skipped / todo are "skipped", not "pending" (= never ran).
    t.eq('BUG-24 test.skip is shown as skipped', h.nodeByName(api, 'src/math.test.js', 'Math utils skipped test').status, 'skipped');
    t.eq('BUG-24 test.todo is shown as skipped', h.nodeByName(api, 'src/math.test.js', 'Math utils todo test').status, 'skipped');

    // BUG-01: console output arrives even with verbose: true in the project config.
    const mathFile = h.fileBySuffix(api, 'src/math.test.js');
    const out = api.store.getFileOutput(mathFile.fileId).lines.map((l) => l.text);
    t.check('BUG-01 console.log captured (project has verbose: true)', out.some((l) => l.includes('adding ✓ ünïcödé')),
      `file output: ${JSON.stringify(out)}`);

    // BUG-24 #2: files Jest will never run must not spin, fail, or trigger the fallback.
    for (const rel of ['e2e/login.spec.js', 'src/legacy.test.mjs']) {
      const f = api.store.getAllFiles().find((x) => x.filePath.replace(/\\/g, '/').endsWith(rel));
      if (!f) { t.check(`BUG-24 ${rel} is not listed as a runnable test`, true); continue; }
      t.check(`BUG-24 ${rel} is not running/failed (Jest never runs it)`, f.status !== 'running' && f.status !== 'failed',
        `status ${f.status}`);
    }
    const fallbacks = logs.filter((l) => /falling back to plain Jest|retrying it with plain Jest/.test(l));
    t.check('BUG-24 no plain-Jest fallback runs', fallbacks.length === 0, fallbacks.join('\n'));

    // BUG-11: summary total equals the number of test nodes.
    const testNodes = h.allNodes(api).filter((n) => n.type === 'test');
    t.eq('BUG-11 summary.total matches the test nodes in the store', api.store.getSummary().total, testNodes.length);

    // BUG-13: one store entry per file (no case / separator duplicates).
    const keys = api.store.getAllFiles().map((f) => f.fileId.toLowerCase().replace(/\//g, '\\'));
    t.eq('BUG-13 no duplicate file entries', keys.length, new Set(keys).size);
    const missing = logs.filter((l) => /0\/\d+ file\(s\) reported|No result for/.test(l));
    t.check('BUG-13 every file in a batch reported a result', missing.length === 0, missing.join('\n'));

    // BUG-04: per-test trace recorded → source files map to the tests using them.
    const mathSrc = path.join(workspace, 'src', 'math.js');
    const affected = api.traceStore.getAffectedTestFiles(mathSrc)
      .concat(api.traceStore.getAffectedTestFiles(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase())));
    t.check('BUG-04 trace maps src/math.js → math.test.js', affected.some((f) => f.endsWith('math.test.js')),
      `sourceToTests for math.js: ${JSON.stringify(affected)}\n${api.traceStore.dump().slice(0, 1500)}`);
    const lineTests = api.traceStore.getTestsForLine(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase()), 2);
    // With project beforeEach/afterEach hooks in setupTests.js (BUG-28).
    t.check('BUG-04/28 covering tests known for math.js line 2 (add)', lineTests.length >= 2,
      JSON.stringify(lineTests));

    // BUG-09: coverage measured for files the tests used.
    const cov = api.coverageStore.getEntry(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase()));
    t.check('BUG-09 src/math.js coverage is measured', cov && cov.state === 'measured', JSON.stringify(cov));

    rec.stop();
  },
};
