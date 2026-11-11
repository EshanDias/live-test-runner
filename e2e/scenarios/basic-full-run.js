'use strict';
/**
 * Full run on the basic fixture: everything that must be true once "Start
 * Testing" completes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../lib/harness');

/**
 * The extension's transform-cache folders whose generated Jest configs name
 * this workspace: { dir, configs, caches } (caches = Jest's own
 * jest-transform-cache-<id> folders inside), counting only what was written
 * since `sinceMs` (earlier e2e runs may have left older ones).
 */
function transformCachesFor(workspace, sinceMs) {
  const base = path.join(os.tmpdir(), 'com.eshLabs', 'live-test-runner');
  const real = fs.realpathSync(workspace);
  const out = [];
  for (const d of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.startsWith('transform-cache-')) : []) {
    const dir = path.join(base, d);
    const recent = (n) => fs.statSync(path.join(dir, n)).mtimeMs >= sinceMs - 1000;
    const names = fs.readdirSync(dir);
    const configs = names.filter((n) => /^ltr-jest-config-.*\.js$/.test(n))
      .filter((n) => { const text = fs.readFileSync(path.join(dir, n), 'utf8'); return text.includes(JSON.stringify(workspace)) || text.includes(JSON.stringify(real)); });
    if (configs.length > 0) { out.push({ dir, configs: configs.length, caches: names.filter((n) => n.startsWith('jest-transform-cache-') && recent(n)).length }); }
  }
  return out;
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const startedMs = Date.now();

    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.sleep(500); // let trailing observer notifications land
    const logs = h.logsSince(api, since);
    t.info(`events: ${rec.events.map((e) => e.type).join(' ')}`.slice(0, 400));

    // Nothing may still spin once the run is over.
    const spinning = h.nodesWithStatus(api, 'running');
    t.check('no test left "running" after the full run', spinning.length === 0,
      spinning.map((n) => n.id).join('\n'));

    // Exactly one run-finished, and nothing running at that moment.
    const finished = rec.of('run-finished');
    t.eq('one run-finished event for one Start', finished.length, 1);
    t.check('run-finished only after every test settled', finished.every((e) => e.running === 0),
      JSON.stringify(finished));

    // Results
    t.eq('math.test.js results', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('strings.test.js results', h.statusCounts(api, 'src/strings.test.js'), { passed: 4 });
    // Nested optional chains used to crash instrumentation of invoice.js.
    t.eq('invoice.test.js results (nested ?. instrumented)', h.statusCounts(api, 'src/invoice.test.js'), { passed: 2 });
    // Real-project lessons (see the comments in each fixture file).
    t.eq('it.each $var table + duplicate names: all 4 results kept', h.statusCounts(api, 'src/table.test.js'), { passed: 4 });
    t.eq('--resetMocks from the test script is honoured', h.statusCounts(api, 'src/mocks.test.js'), { passed: 2 });
    t.eq('a test that mocks fs passes', h.statusCounts(api, 'src/fsmock.test.js'), { passed: 1 });
    const fsErrors = logs.filter((l) => /could not write|is not a function/.test(l));
    t.check('coverage / trace writing unaffected by jest.mock(\'fs\')', fsErrors.length === 0, fsErrors.join('\n'));
    h.checkMatchesPlainJest(api, t, workspace);

    // Skipped / todo are "skipped", not "pending" (= never ran).
    const skip = h.nodeByName(api, 'src/math.test.js', 'Math utils skipped test');
    t.eq('test.skip is shown as skipped (no todo icon)', [skip.status, !!skip.todo], ['skipped', false]);
    const todo = h.nodeByName(api, 'src/math.test.js', 'Math utils todo test');
    t.eq('test.todo is skipped, with the todo icon', [todo.status, todo.todo], ['skipped', true]);

    // Console output arrives even with verbose: true in the project config.
    const mathFile = h.fileBySuffix(api, 'src/math.test.js');
    const out = api.store.getFileOutput(mathFile.fileId).lines.map((l) => l.text);
    t.check('console.log captured (project has verbose: true)', out.some((l) => l.includes('adding ✓ ünïcödé')),
      `file output: ${JSON.stringify(out)}`);

    // Files Jest will never run must not spin, fail, or trigger the fallback.
    for (const rel of ['e2e/login.spec.js', 'src/legacy.test.mjs']) {
      const f = api.store.getAllFiles().find((x) => x.filePath.replace(/\\/g, '/').endsWith(rel));
      if (!f) { t.check(`${rel} is not listed as a runnable test`, true); continue; }
      t.check(`${rel} is not running/failed (Jest never runs it)`, f.status !== 'running' && f.status !== 'failed',
        `status ${f.status}`);
    }
    const fallbacks = logs.filter((l) => /falling back to plain Jest|retrying it with plain Jest/.test(l));
    t.check('no plain-Jest fallback runs', fallbacks.length === 0, fallbacks.join('\n'));

    // Summary total equals the number of test nodes.
    const testNodes = h.allNodes(api).filter((n) => n.type === 'test');
    t.eq('summary.total matches the test nodes in the store', api.store.getSummary().total, testNodes.length);

    // Each file that ran shows how long the whole file took.
    const ranFiles = api.store.getAllFiles().filter((f) => f.status === 'passed' || f.status === 'failed');
    const noTime = ranFiles.filter((f) => !(f.duration > 0)).map((f) => f.name);
    t.check(`every file that ran has its total time (${ranFiles.length} files)`, ranFiles.length > 0 && noTime.length === 0,
      `no duration: ${noTime.join(', ')}`);

    // One store entry per file (no case / separator duplicates).
    const keys = api.store.getAllFiles().map((f) => f.fileId.toLowerCase().replace(/\//g, '\\'));
    t.eq('no duplicate file entries', keys.length, new Set(keys).size);
    const missing = logs.filter((l) => /0\/\d+ file\(s\) reported|No result for/.test(l));
    t.check('every file in a batch reported a result', missing.length === 0, missing.join('\n'));

    // Every batch shares one config file, so one Jest transform cache: a config
    // path per batch made each batch compile every file again (and left one
    // cache folder per batch on disk).
    const batches = new Set(logs.map((l) => /\b(b\d+): running \d+ file/.exec(l)?.[1]).filter(Boolean));
    const caches = transformCachesFor(workspace, startedMs);
    t.check(`${batches.size} batches share one generated config and one transform cache`,
      batches.size >= 2 && caches.length === 1 && caches[0].configs >= 1 && caches[0].caches <= 1,
      `batches ${[...batches].join(', ')}; caches ${JSON.stringify(caches)}`);

    // Per-test trace recorded → source files map to the tests using them.
    const mathSrc = path.join(workspace, 'src', 'math.js');
    const affected = api.traceStore.getAffectedTestFiles(mathSrc)
      .concat(api.traceStore.getAffectedTestFiles(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase())));
    t.check('trace maps src/math.js → math.test.js', affected.some((f) => f.endsWith('math.test.js')),
      `sourceToTests for math.js: ${JSON.stringify(affected)}\n${api.traceStore.dump().slice(0, 1500)}`);
    const lineTests = api.traceStore.getTestsForLine(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase()), 2);
    // With project beforeEach/afterEach hooks in setupTests.js.
    t.check('covering tests known for math.js line 2 (add)', lineTests.length >= 2,
      JSON.stringify(lineTests));

    // Coverage measured for files the tests used.
    const cov = api.coverageStore.getEntry(mathSrc.replace(/^[A-Z]:/, (m) => m.toLowerCase()));
    t.check('src/math.js coverage is measured', cov && cov.state === 'measured', JSON.stringify(cov));

    // A second Start with no test or config file changed does not wait for
    // `jest --listTests` again (20 s on a 200-file CRA project).
    const since2 = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs2 = h.logsSince(api, since2);
    t.check('second Start reuses the runnable-file list', logs2.some((l) => /remembered from the last session/.test(l)) &&
      !logs2.some((l) => /jest --listTests: \d+ file/.test(l)), logs2.filter((l) => /listTests|Runnable/.test(l)).join('\n'));
    t.eq('second Start: same results', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('no Python environment chip on a JS project', api.explorerView._pythonEnv, null);

    rec.stop();
  },
};
