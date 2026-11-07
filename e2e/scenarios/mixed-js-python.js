'use strict';
/**
 * JS and Python in one folder: a Jest root that is a
 * pytest project too is one project that runs both. Before Start the
 * Explorer shows both kinds of test files; Start lists with Jest and pytest,
 * groups the files by framework, splits the status bar, and shows what plain
 * Jest and plain pytest report. A .py save reruns pytest only, a .js save
 * Jest only; Stop leaves no process of either.
 */
const path = require('path');
const h = require('../lib/harness');

const cmdsSince = (api, mark, tag) => h.rawSince(api, mark).filter((l) => new RegExp(`^\\[${tag}#\\d+\\] > `).test(l));

async function idle(api) {
  await h.sleep(1500);
  await h.waitFor(() => !api.session.isRunning(), { what: 'runs to finish', timeout: 120_000 });
}

module.exports = {
  workspace: 'fixture:mixed-js-python',
  settings: { 'liveTestRunner.onSaveDebounceMs': 100 },
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    t.eq('one project at the root', reg.contexts.map((c) => [path.relative(workspace, c.root) || '.', c.framework]), [['.', 'jest']]);
    const ctx = reg.contexts[0];
    t.eq('the switcher label names both frameworks before Start', ctx.frameworkLabel, 'jest + pytest');

    await h.waitForDiscovery(api);
    const files = () => api.store.getAllFiles().map((f) => path.relative(workspace, f.filePath).split(path.sep).join('/')).sort();
    t.eq('discovery finds the JS and the Python test files', files(), ['py_tests/test_price.py', 'src/sum.test.js']);

    const since = h.isoNow();
    let mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(api);
    const logs = h.logsSince(api, since);
    t.check('INFO names the mixed project and its split', logs.some((l) => /mixed Jest \+ pytest project \(.*a pytest config\) — Jest runs 1 test file\(s\), pytest 1/.test(l)), logs.join('\n'));
    t.check('Session started line says jest + pytest', logs.some((l) => /Session started — 2 test file\(s\) · framework: jest \+ pytest/.test(l)), logs.filter((l) => /Session started/.test(l)).join('\n'));
    t.check('both ran', cmdsSince(api, mark, 'jest').length > 0 && cmdsSince(api, mark, 'pytest').length > 0, h.rawSince(api, mark).filter((l) => / > /.test(l)).join('\n'));
    t.check('pytest got the .py file only, Jest the .js file only',
      cmdsSince(api, mark, 'pytest').every((l) => !/sum\.test\.js/.test(l)) && cmdsSince(api, mark, 'jest').every((l) => !/test_price\.py/.test(l)));

    const groups = Object.fromEntries(api.store.getAllFiles().map((f) => [path.basename(f.filePath), f.group]).sort(([a], [b]) => a.localeCompare(b)));
    t.eq('the Explorer groups files by framework', groups, { 'sum.test.js': 'Jest', 'test_price.py': 'pytest' });
    t.check('status bar splits the tests per framework', / · Jest 2 · pytest 3$/.test(api.statusBar.text), api.statusBar.text);
    h.checkMatchesPlainJest(api, t, workspace, 'Jest files match plain Jest');
    h.checkMatchesPlainPytest(api, t, workspace, 'Python files match plain pytest');
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);

    // ── Saves wake only the file's own framework ───────────────────────────
    mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'py', 'shop', 'price.py'), (s) => s.replace('return sum(prices)', 'return sum(prices) + 0'));
    await idle(api);
    t.eq('a Python source save starts no Jest', cmdsSince(api, mark, 'jest'), []);
    t.check('…and reruns pytest', cmdsSince(api, mark, 'pytest').length > 0, h.rawSince(api, mark).join('\n'));

    mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'src', 'sum.js'), (s) => s.replace('return a + b;', 'return a + b + 0;'));
    await idle(api);
    t.eq('a JS source save starts no pytest', cmdsSince(api, mark, 'pytest'), []);
    t.check('…and reruns Jest', cmdsSince(api, mark, 'jest').length > 0, h.rawSince(api, mark).join('\n'));

    mark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'py_tests', 'test_price.py'), (s) => s.replace('assert total([]) == 1', 'assert total([]) == 0'));
    await idle(api);
    t.eq('a Python test save starts no Jest', cmdsSince(api, mark, 'jest'), []);
    t.eq('…and its fix shows', h.nodeByName(api, 'py_tests/test_price.py', 'test_fails_on_purpose')?.status, 'passed');

    // ── No usable Python: the JS tests still run ───────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    await cfg.update('pythonPath', path.join(workspace, 'no-such-python'), vscode.ConfigurationTarget.Workspace);
    try {
      const since2 = h.isoNow();
      mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await idle(api);
      const logs2 = h.logsSince(api, since2);
      t.check('the session starts without pytest', api.session.isActive(), logs2.join('\n'));
      t.check('…and says why the Python tests are not run', logs2.some((l) => /pytest tests are not run this session — /.test(l)), logs2.join('\n'));
      t.check('Jest ran', cmdsSince(api, mark, 'jest').length > 0);
      t.eq('pytest did not', cmdsSince(api, mark, 'pytest'), []);
      t.eq('the JS tests passed', h.statusCounts(api, 'sum.test.js'), { passed: 2 });
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    } finally {
      await cfg.update('pythonPath', undefined, vscode.ConfigurationTarget.Workspace);
    }

    // ── Stop ───────────────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await h.sleep(2000);
    t.eq('no Jest process left', h.jestProcesses(workspace), []);
    t.eq('no pytest process left', h.pytestProcesses(workspace), []);
  },
};
