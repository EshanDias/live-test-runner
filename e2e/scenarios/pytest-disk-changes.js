'use strict';
/**
 * pytest: files changed the way coding assistants change them rerun their
 * tests during a session —
 *  - written straight to disk while closed (an agent in a terminal),
 *  - written to disk while open, unmodified, in the editor (the editor reloads it),
 *  - edited in the editor and saved (an assistant inside the editor),
 *  - written to disk while a run is going (rerun once it ends).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const SRC = 'src/shop/pricing.py';
const TEST = 'tests/test_pricing.py';

async function idle(api) {
  await h.sleep(2500);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
}
const pytestRuns = (api, mark) => h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 6 * 60_000,
  settings: { 'liveTestRunner.onSaveDebounceMs': 100 },

  async run({ api, t, vscode, workspace }) {
    const src = path.join(workspace, SRC);
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await idle(api);

    // 1. Written to disk, closed.
    let since = h.isoNow();
    let mark = h.rawMark(api);
    fs.writeFileSync(src, fs.readFileSync(src, 'utf8') + '\n# changed on disk (closed)\n');
    await idle(api);
    t.check('a closed source file written on disk reruns the tests that import it',
      pytestRuns(api, mark).some((l) => l.includes('test_pricing.py')), `${pytestRuns(api, mark).join('\n')}\n${h.logsSince(api, since).join('\n')}`);

    // 2. Written to disk while open (not modified) in the editor.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(src)));
    await h.sleep(500);
    since = h.isoNow();
    mark = h.rawMark(api);
    fs.writeFileSync(src, fs.readFileSync(src, 'utf8') + '# changed on disk (open)\n');
    await idle(api);
    t.check('an open source file written on disk reruns too',
      pytestRuns(api, mark).some((l) => l.includes('test_pricing.py')), `${pytestRuns(api, mark).join('\n')}\n${h.logsSince(api, since).join('\n')}`);

    // 3. Edited in the editor and saved.
    since = h.isoNow();
    mark = h.rawMark(api);
    await h.editAndSave(vscode, src, (s) => s + '# edited in the editor\n');
    await idle(api);
    t.check('an edit saved in the editor reruns', pytestRuns(api, mark).some((l) => l.includes('test_pricing.py')),
      `${pytestRuns(api, mark).join('\n')}\n${h.logsSince(api, since).join('\n')}`);

    // 4. Written while a run is going: rerun once it ends.
    since = h.isoNow();
    mark = h.rawMark(api);
    const file = h.fileBySuffix(api, 'tests/test_cart.py');
    const running = vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: file.fileId });
    await h.waitFor(() => api.session._activeRuns > 0, { what: 'the run to start', timeout: 30_000 });
    fs.writeFileSync(src, fs.readFileSync(src, 'utf8') + '# changed during a run\n');
    await running;
    await idle(api);
    t.check('a file written during a run reruns its tests after it', pytestRuns(api, mark).some((l) => l.includes('test_pricing.py')),
      `${pytestRuns(api, mark).join('\n')}\n${h.logsSince(api, since).join('\n')}`);
    t.eq(`${TEST} still passes`, h.statusCounts(api, TEST).failed, undefined);
  },
};
