'use strict';
/**
 * A real pytest project (LTR_E2E_PYTEST_REPO — click, httpx, erdantic
 * (pytest 7), pytest itself — via e2e/real-repos.js, on a clone with its own
 * .venv): the full run matches a plain `python -m pytest`
 * (LTR_E2E_PYTEST_BASELINE) test for test, discovery finds tests before
 * Start, nothing is written into the project (pytest's cache, pytest-cov's
 * reports), ▶ Run on one test works, a saved test file reruns, and Stop ends
 * every pytest process. A saved file is restored to its exact content.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(1200);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 15 * 60_000 });
  await h.sleep(300);
}

/** The plain run the harness recorded (file → { name → status }), as the Map shape checkMatchesPlainPytest takes. */
function baseline() {
  const file = process.env.LTR_E2E_PYTEST_BASELINE;
  if (!file || !fs.existsSync(file)) { return undefined; }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(Object.entries(json).map(([f, tests]) => [f, new Map(Object.entries(tests))]));
}

/**
 * Tests whose outcome changes from run to run in plain pytest too (timing):
 * a difference there is reported, not counted. httpx's write timeout fails
 * about 1 run in 3 on its own.
 */
const FLAKY = {
  httpx: ['test_write_timeout'],
};

/** Files and folders a pytest run could leave in the project. */
const LEFTOVERS = ['.pytest_cache', '.coverage', 'htmlcov', 'coverage.xml', 'coverage.json'];

module.exports = {
  workspace: 'env:LTR_E2E_PYTEST_REPO',
  timeoutMs: 30 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const discovered = h.allNodes(api).filter((n) => n.type === 'test' || n.isDynamicTemplate).length;
    t.check(`static discovery found tests before Start (${discovered})`, discovered > 0);

    const before = new Set(LEFTOVERS.filter((p) => fs.existsSync(path.join(workspace, p))));
    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    t.info(`full run: ${((Date.now() - started) / 1000).toFixed(0)}s, summary ${JSON.stringify(api.store.getSummary())}`);
    const logs = h.logsSince(api, since);

    t.check('session uses pytest', logs.some((l) => /framework: pytest/.test(l)), logs.filter((l) => /Session started/.test(l)).join('\n'));
    t.check("the clone's .venv runs the tests", logs.some((l) => /\[Python\] .*pytest \d+\.\d+.*\.venv/.test(l)), logs.filter((l) => /Python/.test(l)).join('\n'));
    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    const fallbacks = logs.filter((l) => /falling back to plain|retrying it with plain|returned no results/.test(l));
    t.check('no batch fell back to plain runs', fallbacks.length === 0, fallbacks.join('\n'));

    const plain = baseline();
    if (plain) { h.checkMatchesPlainPytest(api, t, workspace, 'results match plain pytest', plain, FLAKY[path.basename(workspace)] ?? []); }
    else { t.check('a plain pytest baseline was recorded', false, 'LTR_E2E_PYTEST_BASELINE not set'); }

    const left = LEFTOVERS.filter((p) => !before.has(p) && fs.existsSync(path.join(workspace, p)));
    t.check('nothing written into the project (pytest cache, coverage reports)', left.length === 0, left.join(', '));

    // ▶ Run one test that passed: still passes, alone.
    const passing = h.allNodes(api).find((n) => n.type === 'test' && n.status === 'passed' && !/[[\]]/.test(n.name));
    if (passing) {
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: passing.fileId, nodeId: passing.id, fullName: passing.fullName });
      await waitIdle(api);
      const raw = h.rawSince(api, mark);
      t.eq(`▶ Run ${passing.fullName}: passes again`, api.store.getNode(passing.id)?.status, 'passed');
      t.check('…selected by node id', raw.some((l) => / -m pytest /.test(l) && l.includes(`::${passing.name}`)), raw.filter((l) => / -m pytest /.test(l)).join('\n'));
      t.check('…one test ran', raw.some((l) => /\b1 passed\b/.test(l)), raw.slice(-5).join('\n'));
    }

    // Saving a test file reruns it.
    const file = passing ? passing.fileId : api.store.getAllFiles()[0]?.filePath;
    if (file) {
      const original = fs.readFileSync(file);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc);
        const mark = h.rawMark(api);
        await h.editAndSave(vscode, file, (text) => text + '\n');
        await waitIdle(api);
        const raw = h.rawSince(api, mark);
        t.check(`saving ${path.basename(file)} reruns it`, raw.some((l) => / -m pytest /.test(l) && l.includes(path.basename(file))), raw.filter((l) => / -m pytest /.test(l)).join('\n'));
      } finally {
        fs.writeFileSync(file, original);
      }
    }

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    t.eq('after Stop nothing is running', h.nodesWithStatus(api, 'running').length, 0);
  },
};
