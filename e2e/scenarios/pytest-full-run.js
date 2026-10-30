'use strict';
/**
 * Full run of a pytest project (fixture pytest-basic, pytest 9.1 in its own
 * .venv): the extension finds the project's virtual environment, shows the
 * tests statically before Start, asks pytest which files it collects, runs
 * them with the shipped plugin and shows exactly what a plain pytest run
 * reports — and leaves the project as it was (no .pytest_cache, no coverage
 * files).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const CART = 'tests/test_cart.py';
const texts = (o) => (o?.lines || []).map((l) => l.text);

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    // Static discovery (the line scanner) — before anything runs.
    const names = (suffix) => h.allNodes(api).filter((n) => (n.type === 'test' || n.isDynamicTemplate) && n.fileId.replace(/\\/g, '/').endsWith(suffix)).map((n) => n.fullName);
    const discovered = names(CART);
    t.check('discovery finds class tests, nested classes and parametrize templates before Start',
      ['TestCart test_empty', 'TestCart test_rejects_bad_qty[…]', 'TestCart TestNested test_inner', 'test_discount[…]', 'test_logs'].every((n) => discovered.includes(n)),
      JSON.stringify(discovered));
    t.check('discovery finds unittest.TestCase methods', names('tests/test_unittest_style.py').includes('DiscountTests test_half'), JSON.stringify(names('tests/test_unittest_style.py')));
    t.check('discovery skips files outside testpaths', !h.allNodes(api).some((n) => n.fileId.replace(/\\/g, '/').includes('/docs/')));
    t.eq('static line of a test is its def line', h.nodeByName(api, CART, 'TestCart test_add')?.line, 15);

    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.sleep(500);
    const logs = h.logsSince(api, since);
    const raw = h.rawSince(api, mark);

    t.check('session uses pytest', logs.some((l) => /framework: pytest/.test(l)), logs.filter((l) => /Session started/.test(l)).join('\n'));
    t.check("the project's .venv is found and described", logs.some((l) => /Python 3\.\d+\.\d+ · pytest 9\.1\.1 · coverage 7\.17\.0 — .*\.venv.* \(\.venv\)/.test(l)),
      logs.filter((l) => /Python/.test(l)).join('\n'));
    const cmds = raw.filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
    t.check('pytest processes are tagged [pytest#N] and load the plugin with -p only', cmds.length > 0 && cmds.every((l) => / -m pytest -p ltr_pytest /.test(l)), cmds.join('\n'));
    t.check("runs keep pytest's cache in the session folder", cmds.every((l) => /cache_dir=/.test(l)), cmds.join('\n'));
    t.check('no Jest or Vitest process', !raw.some((l) => /^\[(jest|vitest)#\d+\] > /.test(l)));
    // Asked now, or remembered from an earlier session (Windows copies keep file times, so the cache key can match).
    t.check('pytest --collect-only listed the files (now or remembered)',
      cmds.some((l) => /--collect-only/.test(l)) || logs.some((l) => /pytest --collect-only|remembered from the last session/.test(l)), cmds.join('\n'));

    const spinning = h.nodesWithStatus(api, 'running');
    t.check('nothing left "running"', spinning.length === 0, spinning.map((n) => n.id).join('\n'));
    t.eq('one run-finished', rec.of('run-finished').length, 1);

    h.checkMatchesPlainPytest(api, t, workspace);
    t.eq('test_cart.py results', h.sortedCounts(api, CART), { failed: 2, passed: 9, skipped: 2 });

    const failing = h.nodeByName(api, CART, 'TestCart test_fails_on_purpose');
    const msg = (failing?.failureMessages || []).join('\n');
    t.check("a failed assert shows pytest's own explanation", /assert 5 == 4/.test(msg) && /test_cart\.py:\d+: AssertionError/.test(msg), msg);
    const setupErr = h.nodeByName(api, CART, 'test_setup_error');
    t.check('an error in a fixture fails the test and says so', setupErr?.status === 'failed' && (setupErr.failureMessages || []).some((m) => /Error in setup of test_setup_error/.test(m) && /fixture setup failed on purpose/.test(m)),
      JSON.stringify(setupErr?.failureMessages));
    t.eq('skip → skipped', h.nodeByName(api, CART, 'test_skipped')?.status, 'skipped');
    t.eq('xfail → skipped', h.nodeByName(api, CART, 'test_expected_failure')?.status, 'skipped');
    t.eq('parametrize case under its template', h.nodeByName(api, CART, 'test_discount[HALF-50]')?.status, 'passed');
    t.eq('test line from pytest (def line)', h.nodeByName(api, CART, 'TestCart test_add')?.line, 15);

    const broken = h.fileBySuffix(api, 'tests/test_broken.py');
    t.eq('a file that cannot be imported is failed', broken?.status, 'failed');
    const brokenTest = h.nodeByName(api, 'tests/test_broken.py', 'test_never_runs');
    t.check('…and its tests say why', (brokenTest?.failureMessages || []).some((m) => /does_not_exist/.test(m)), JSON.stringify(brokenTest?.failureMessages));

    // Output per test (pytest's capture sections), never back-filled.
    t.check('a test shows its own print', texts(api.store.getNodeOutput(h.nodeByName(api, CART, 'TestCart test_add').id)).some((l) => /adding apples/.test(l)),
      JSON.stringify(api.store.getNodeOutput(h.nodeByName(api, CART, 'TestCart test_add').id)));
    const failOut = texts(api.store.getNodeOutput(failing.id)).join('\n');
    t.check('…stdout and stderr of a failing test', /total is 5/.test(failOut) && /to stderr/.test(failOut), failOut);
    t.check('…log records', texts(api.store.getNodeOutput(h.nodeByName(api, CART, 'test_logs').id)).some((l) => /a warning from the shop/.test(l)));
    const empty = api.store.getNodeOutput(h.nodeByName(api, CART, 'TestCart test_empty').id);
    t.check('a quiet test that ran has empty output (not a placeholder)', empty && empty.lines.length === 0 && empty.capturedAt > 0, JSON.stringify(empty));

    // The project is left as it was (CLAUDE.md rule 9).
    for (const p of ['.pytest_cache', 'tests/.pytest_cache', '.coverage', 'htmlcov', 'coverage.xml']) {
      t.check(`no ${p} written into the project`, !fs.existsSync(path.join(workspace, p)));
    }
    const fallbacks = logs.filter((l) => /falling back to plain|retrying it with plain/.test(l));
    t.check('no plain fallback runs', fallbacks.length === 0, fallbacks.join('\n'));
    t.eq('summary.total matches the test nodes', api.store.getSummary().total, h.allNodes(api).filter((n) => n.type === 'test').length);
    rec.stop();
  },
};
