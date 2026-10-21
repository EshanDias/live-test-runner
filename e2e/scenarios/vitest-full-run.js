'use strict';
/**
 * Full run of a Vitest project (fixture vitest-basic, Vitest 3.2 — the
 * supported baseline): the extension picks the Vitest services, asks
 * `vitest list` which files run, and shows the same results as plain Vitest.
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    // Static discovery (no Babel in this project: the extension's own parser) — before any run.
    const discovered = h.allNodes(api).filter((n) => (n.type === 'test' || n.isDynamicTemplate) && n.fileId.replace(/\\/g, '/').endsWith('src/syntax.test.ts')).map((n) => n.name);
    t.check('discovery finds test.extend / .for / skipIf / runIf tests before Start',
      ['fixture value', 'for row %i', 'skipped by skipIf', 'run by runIf'].every((n) => discovered.includes(n)), JSON.stringify(discovered));
    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const mark = h.rawMark(api);

    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.sleep(500);
    const logs = h.logsSince(api, since);
    const raw = h.rawSince(api, mark);

    t.check('session uses Vitest', logs.some((l) => /framework: vitest/.test(l)), logs.filter((l) => /Session started/.test(l)).join('\n'));
    const cmds = raw.filter((l) => /^\[vitest#\d+\] > /.test(l));
    t.check('Vitest processes are tagged [vitest#N]', cmds.length > 0, raw.slice(0, 10).join('\n'));
    t.check('runs pass --reporter=json (the config\'s "dot" reporter is replaced)',
      cmds.some((l) => / run /.test(l) && /--reporter=json/.test(l)), cmds.join('\n'));
    t.check('no Jest process was started', !raw.some((l) => /^\[jest#\d+\] > /.test(l)));

    const spinning = h.nodesWithStatus(api, 'running');
    t.check('nothing left "running"', spinning.length === 0, spinning.map((n) => n.id).join('\n'));
    t.eq('one run-finished', rec.of('run-finished').length, 1);

    t.eq('math.test.js results', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('strings.test.ts results', h.statusCounts(api, 'src/strings.test.ts'), { passed: 1, failed: 1 });
    t.eq('top-level.spec.js results', h.statusCounts(api, 'src/top-level.spec.js'), { passed: 1 });
    t.eq('syntax.test.ts results (extend / for / skipIf / runIf)', h.statusCounts(api, 'src/syntax.test.ts'), { passed: 4, skipped: 1 });
    h.checkMatchesPlainVitest(api, t, workspace);

    // Nested describe and test.each rows land under the right suites.
    t.eq('nested suite test', h.nodeByName(api, 'src/math.test.js', 'Math utils divide throws on zero')?.status, 'passed');
    t.eq('test.each row', h.nodeByName(api, 'src/math.test.js', 'Math utils add(2, 3) = 5')?.status, 'passed');
    t.eq('it.todo is skipped, not pending', h.nodeByName(api, 'src/math.test.js', 'Math utils todo test')?.status, 'skipped');
    const fails = h.nodeByName(api, 'src/strings.test.ts', 'strings fails on purpose');
    t.check('failure message kept, without the stack', fails && fails.failureMessages.some((m) => /expected 'HI!' to be 'hi'/.test(m)) &&
      !fails.failureMessages.some((m) => /\n\s+at /.test(m)), JSON.stringify(fails?.failureMessages));
    const line = h.nodeByName(api, 'src/math.test.js', 'Math utils divide divides')?.line;
    t.eq('test line from --includeTaskLocation', line, 11);

    // A file Vitest cannot load: failed, with Vitest's reason.
    const broken = h.fileBySuffix(api, 'src/broken.test.js');
    const brokenTest = h.nodeByName(api, 'src/broken.test.js', 'never runs');
    t.eq('broken.test.js is failed', broken?.status, 'failed');
    t.check('broken.test.js shows why', brokenTest && brokenTest.failureMessages.some((m) => /does-not-exist/.test(m)),
      JSON.stringify(brokenTest?.failureMessages));

    // A file the Vitest config does not include is not run.
    const login = api.store.getAllFiles().find((f) => f.filePath.replace(/\\/g, '/').endsWith('e2e/login.spec.js'));
    t.check('e2e/login.spec.js (not in include) is not run', !login || (login.status !== 'running' && login.status !== 'failed' && login.status !== 'passed'),
      `status ${login?.status}`);
    const fallbacks = logs.filter((l) => /falling back to plain|retrying it with plain/.test(l));
    t.check('no plain fallback runs', fallbacks.length === 0, fallbacks.join('\n'));

    t.eq('summary.total matches the test nodes', api.store.getSummary().total, h.allNodes(api).filter((n) => n.type === 'test').length);
    rec.stop();
  },
};
