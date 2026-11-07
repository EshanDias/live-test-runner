'use strict';
/**
 * Files changed outside the editor while a session is on:
 *  - a source file changed on disk reruns the tests that use it
 *  - the editor's own save is not counted twice
 *  - many files at once (a branch switch) restart the session
 *  - a file a test writes during a run that no test loads starts nothing
 *  - many files written during a run (by the tests) never restart the session
 *  - nothing reruns once the session is stopped
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(1500); // batch window + save debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(500);
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api);
    t.check('full run: math tests pass', !h.statusCounts(api, 'src/math.test.js').failed, JSON.stringify(h.statusCounts(api, 'src/math.test.js')));

    const mathPath = path.join(workspace, 'src', 'math.js');
    const original = fs.readFileSync(mathPath, 'utf8');
    const extra = [];
    try {
      // 1. Break add() on disk, outside the editor.
      let since = h.isoNow();
      fs.writeFileSync(mathPath, original.replace('return a + b;', 'return a - b;'));
      await h.waitFor(() => (h.statusCounts(api, 'src/math.test.js').failed ?? 0) > 0, { what: 'math tests to fail after the disk change', timeout: 60_000 });
      await waitIdle(api);
      t.check('a source file changed on disk reruns its tests (add() now fails)', (h.statusCounts(api, 'src/math.test.js').failed ?? 0) > 0);
      t.check('…and the log says why', h.logsSince(api, since).some((l) => /math\.js changed on disk/.test(l)), h.logsSince(api, since).join('\n'));

      // 2. Put it back on disk: the tests pass again.
      fs.writeFileSync(mathPath, original);
      await h.waitFor(() => !h.statusCounts(api, 'src/math.test.js').failed, { what: 'math tests to pass again', timeout: 60_000 });
      await waitIdle(api);
      t.check('restored on disk: the tests pass again', !h.statusCounts(api, 'src/math.test.js').failed);

      // 3. A save in the editor is one rerun, not two (the disk event of the save is ignored).
      since = h.isoNow();
      await h.editAndSave(vscode, mathPath, (text) => text.replace('return a * b;', 'return a * b; // saved'));
      await waitIdle(api);
      const logs = h.logsSince(api, since);
      t.check('editor save: no "changed on disk" rerun on top of the save', !logs.some((l) => /changed on disk/.test(l)), logs.join('\n'));

      // 4. Many files at once (a branch switch): the session restarts.
      since = h.isoNow();
      const gen = [];
      for (let i = 0; i < 25; i++) {
        const f = path.join(workspace, 'src', `gen${i}.js`);
        fs.writeFileSync(f, `module.exports = ${i};\n`);
        gen.push(f);
      }
      await h.waitFor(() => h.logsSince(api, since).some((l) => /files changed on disk .* restarting the session/.test(l)), { what: 'the session restart', timeout: 30_000 });
      t.check('25 files changed on disk: the session restarts once', true);
      await waitIdle(api);
      for (const f of gen) { fs.rmSync(f, { force: true }); }
      await waitIdle(api);

      // 5. Changed during a run: queued, rerun when the run finishes. A test that
      //    writes a file every run reruns once more at most (loop guard).
      const slow = path.join(workspace, 'src', 'slow5.test.js');
      const writer = path.join(workspace, 'src', 'writer.test.js');
      const generated = path.join(workspace, 'src', 'generated.js');
      const unused = path.join(workspace, 'src', 'unused-output.js');
      extra.push(slow, writer, generated, unused);
      fs.writeFileSync(slow, "test('takes five seconds', () => new Promise((r) => setTimeout(r, 5000)), 20000);\n");
      fs.writeFileSync(writer, "const fs = require('fs');\nconst path = require('path');\ntest('writes generated.js', () => {\n  fs.writeFileSync(path.join(__dirname, 'generated.js'), 'module.exports = ' + Date.now() + ';\\n');\n  fs.writeFileSync(path.join(__dirname, 'unused-output.js'), 'module.exports = ' + Date.now() + ';\\n');\n  expect(typeof require('./generated')).toBe('number');\n});\n");
      await h.sleep(2500); // new test files reach discovery
      await waitIdle(api);
      since = h.isoNow();
      const restarted = vscode.commands.executeCommand('liveTestRunner.startTesting'); // restart: every file runs, slow5 keeps the run going
      await h.waitFor(() => api.session.isRunning(), { what: 'the run to start' });
      await h.sleep(1500);
      fs.writeFileSync(mathPath, original.replace('return a + b;', 'return a - b;'));
      t.check('math.js changed while the run is still going', api.session.isRunning());
      await restarted;
      await h.waitFor(() => (h.statusCounts(api, 'src/math.test.js').failed ?? 0) > 0, { what: 'the queued rerun of math.js', timeout: 90_000 });
      await waitIdle(api);
      await h.sleep(3000);
      await waitIdle(api);
      const runLogs = h.logsSince(api, since);
      t.check('changed during a run: queued, not dropped', runLogs.some((l) => /changed on disk during a run — queued/.test(l)), runLogs.filter((l) => /disk/.test(l)).join('\n'));
      t.check('…and rerun when the run finished (math tests now fail)', (h.statusCounts(api, 'src/math.test.js').failed ?? 0) > 0);
      t.check('a test that writes a file each run: stopped after one extra rerun, with a warning',
        runLogs.some((l) => /generated\.js.* changed again while .* probably written by a test/.test(l)), runLogs.filter((l) => /disk|generated/.test(l)).join('\n'));
      const queuedReruns = runLogs.filter((l) => /changed on disk during the run\)/.test(l)).length;
      t.check('…no endless reruns (at most 2 queued reruns)', queuedReruns <= 2, String(queuedReruns));
      t.check('a file a test writes that no test loads: no rerun for it',
        !runLogs.some((l) => /Run #\d+ disk change unused-output\.js/.test(l)), runLogs.filter((l) => /unused-output/.test(l)).join('\n'));
      fs.writeFileSync(mathPath, original);
      for (const f of extra) { fs.rmSync(f, { force: true }); }
      await h.sleep(1500);
      await waitIdle(api);

      // 5b. A test that writes many files during its run (25 modules it loads, and
      //     test files under e2e/, which the config never runs — like Jest's own
      //     e2e tests): no session restart (it would wipe the results and write
      //     them all again, forever), one line instead.
      const many = path.join(workspace, 'src', 'many.test.js');
      const writtenDir = path.join(workspace, 'src', 'written');
      const fixturesDir = path.join(workspace, 'e2e', 'written');
      extra.push(many, writtenDir, fixturesDir);
      fs.writeFileSync(many, "const fs = require('fs');\nconst path = require('path');\ntest('writes many files', () => {\n  const dir = path.join(__dirname, 'written');\n  fs.mkdirSync(dir, { recursive: true });\n  const fx = path.join(__dirname, '..', 'e2e', 'written');\n  fs.mkdirSync(fx, { recursive: true });\n  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(fx, 'w' + i + '.test.js'), \"test('x', () => {});\\n\"); }\n  let sum = 0;\n  for (let i = 0; i < 25; i++) {\n    fs.writeFileSync(path.join(dir, 'w' + i + '.js'), 'module.exports = ' + i + ';\\n');\n    sum += require(path.join(dir, 'w' + i + '.js'));\n  }\n  expect(sum).toBe(300);\n});\n");
      since = h.isoNow();
      await h.waitFor(() => h.logsSince(api, since).some((l) => /probably written by the tests, not rerunning them/.test(l)), { what: 'the "written by the tests" line', timeout: 60_000 });
      await waitIdle(api);
      await h.sleep(2000);
      await waitIdle(api);
      const manyLogs = h.logsSince(api, since);
      t.check('a test writing 25+ files during its run: no session restart', !manyLogs.some((l) => /restarting the session/.test(l)), manyLogs.filter((l) => /disk/.test(l)).join('\n'));
      t.check('…the results stay (math tests still have results)', h.statusCounts(api, 'src/math.test.js').passed > 0, JSON.stringify(h.statusCounts(api, 'src/math.test.js')));
      t.check('…the test files it wrote under e2e/ (not run by the config) start nothing', !manyLogs.some((l) => /Run #\d+ disk change w\d\.test\.js/.test(l)), manyLogs.join('\n'));
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const f of extra) { fs.rmSync(f, { recursive: true, force: true }); }
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);

      // 6. Stopped: disk changes run nothing.
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      since = h.isoNow();
      fs.writeFileSync(mathPath, original.replace('return a + b;', 'return a - b;'));
      await h.sleep(2500);
      t.check('stopped: a disk change reruns nothing', !h.logsSince(api, since).some((l) => /changed on disk/.test(l)));
    } finally {
      fs.writeFileSync(mathPath, original);
      for (const f of extra) { fs.rmSync(f, { recursive: true, force: true }); }
    }
  },
};
