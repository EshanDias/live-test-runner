'use strict';
/**
 * The first Start of a large project waits for the framework's list of the
 * files it runs (pytest --collect-only: half a minute on 2,500 files). When
 * that list is not remembered from the last session, the test files open in
 * the editor run while the list is made; a file the list then leaves out
 * loses its results, coverage and trace again and shows as not run.
 * Here the project's conftest makes the listing slow and ignores one test file.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const runner = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'utils', 'resources.js'));

const CONFTEST = [
  'import time',
  '',
  '# Live Test Runner e2e: pytest leaves this file out of its collection.',
  'collect_ignore = ["tests/test_ignored.py"]',
  '',
  '',
  'def pytest_collection_finish(session):',
  '    if session.config.option.collectonly:',
  '        time.sleep(5)  # a slow listing, as on a large project',
  '',
].join('\n');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const ignored = path.join(workspace, 'tests', 'test_ignored.py');
    fs.writeFileSync(path.join(workspace, 'conftest.py'), CONFTEST);
    fs.writeFileSync(ignored, 'from shop.untested import never_called\n\n\ndef test_calls_it():\n    assert never_called(True) == 1\n');
    try {
      await h.waitForDiscovery(api);
      await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('test_ignored.py')), { what: 'test_ignored.py discovered', timeout: 30_000 });
      // Let the file watcher report the two writes before Start (a late event would count as a change during the run).
      await h.sleep(2000);
      // The first Start of this test-file set: nothing remembered.
      fs.rmSync(api.storagePaths(api.projects.contexts[0].root).runnableFiles, { force: true });

      const cart = path.join(workspace, 'tests', 'test_cart.py');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(cart)));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(ignored)), vscode.ViewColumn.Beside);

      const rec = h.recordEvents(api);
      const mark = h.rawMark(api);
      const since = h.isoNow();
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.settle(api);
      const logs = h.logsSince(api, since);

      const listed = logs.find((l) => /pytest --collect-only: \d+ file\(s\) in/.test(l));
      const listedAt = listed ? Date.parse(listed.slice(0, 24)) : NaN;
      const cartAt = rec.of('file-result').find((e) => e.file === 'test_cart.py')?.at;
      const earlyLogged = logs.some((l) => /test file\(s\) open in the editor while pytest lists/.test(l));
      const ignoredRan = h.rawSince(api, mark).some((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l) && l.includes('test_ignored.py') && !l.includes('--collect-only'));
      if (runner.maxBatchSlots(runner.coreCount(), 'balanced', false) > 1) {
        t.check('the open test file has its result before pytest finished listing the files', !!cartAt && cartAt < listedAt,
          `test_cart.py at ${cartAt && new Date(cartAt).toISOString()}, list at ${listed}`);
        t.check('the early run is logged', earlyLogged, logs.join('\n'));
        t.check('the left-out file did run early (its results had to be dropped)', ignoredRan);
      } else {
        // Budget 1 (a small machine): the listing is the one process; nothing runs beside it.
        t.check('one process at a time: no early run beside the listing', !earlyLogged && !ignoredRan && !!cartAt && cartAt > listedAt, logs.join('\n'));
      }
      const ign = h.fileBySuffix(api, 'tests/test_ignored.py');
      t.check('the file pytest leaves out shows as not run', ign.status === 'skipped' && !!ign.excluded, JSON.stringify({ status: ign.status, excluded: ign.excluded }));
      const untested = path.join(workspace, 'src', 'shop', 'untested.py').replace(/^[A-Z]:/, (m) => m.toLowerCase());
      t.eq('…its coverage is gone (untested.py has no contributor)', api.coverageStore.contributorsOf(untested), []);
      t.eq('…and its trace', api.traceStore.getAffectedTestFiles(untested), []);

      t.eq('the other files ran once each', rec.of('file-result').filter((e) => e.file === 'test_cart.py').length, 1);
      t.check('every collected file has a result', api.store.getAllFiles().filter((f) => !f.excluded).every((f) => f.status === 'passed' || f.status === 'failed'),
        JSON.stringify(api.store.getAllFiles().map((f) => [f.name, f.status])));
      t.eq('nothing left running', h.nodesWithStatus(api, 'running').length, 0);
      t.eq('one run-finished', rec.of('run-finished').length, 1);
      rec.stop();
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      fs.rmSync(path.join(workspace, 'conftest.py'), { force: true });
      fs.rmSync(ignored, { force: true });
    }
  },
};
