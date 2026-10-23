'use strict';
/**
 * Source-file saves with Vitest (phase 6): a saved source file runs
 * `vitest related <file> --run` through the live batch runner — its test
 * file shows running before its result, progress counts it, the result
 * streams in, and the saved file's coverage is measured again (a new,
 * uncalled function lowers it). A file no test imports reruns nothing.
 * Saving the Vitest config restarts the session (every test reruns).
 * Every saved file gets its exact content back.
 *
 * Runs with the execution trace off (liveTestRunner.vitestTrace: false):
 * `vitest related` is then the save path, as it is whenever the trace is
 * unavailable (see vitest-trace for the traced path).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}
const vitestCmds = (lines) => lines.filter((l) => /^\[vitest#\d+\] > /.test(l));
const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

module.exports = {
  workspace: 'fixture:vitest-basic',
  settings: { 'liveTestRunner.vitestTrace': false },
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const mathJs = path.join(workspace, 'src', 'math.js');
    const untested = path.join(workspace, 'src', 'untested.js');
    const config = path.join(workspace, 'vitest.config.mjs');
    const originals = new Map([mathJs, untested, config].map((f) => [f, fs.readFileSync(f, 'utf8')]));
    try {
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      const before = api.coverageStore.getEntry(key(mathJs));
      t.eq('math.js measured by the full run', before?.state, 'measured');

      // ── A source file: its related tests, live, with coverage ──
      let rec = h.recordEvents(api);
      let mark = h.rawMark(api);
      let since = h.isoNow();
      await h.editAndSave(vscode, mathJs, (s) => s + '\nexport function triple(n) {\n  return n * 3;\n}\n');
      await waitIdle(api);
      let cmds = vitestCmds(h.rawSince(api, mark));
      let logs = h.logsSince(api, since);
      t.check('saved math.js runs `vitest related … --run`', cmds.some((l) => / related .*math\.js.* --run/.test(l)), cmds.join('\n'));
      t.check('…as a live batch with coverage (only batches measure coverage)', cmds.some((l) => / related /.test(l) && /--coverage\.enabled=true/.test(l)), cmds.join('\n'));
      t.check('…not the plain related run', !logs.some((l) => /plain Vitest/.test(l)), logs.join('\n'));
      const rerunning = rec.of('files-rerunning');
      const results = rec.of('file-result').map((e) => e.file);
      t.check('math.test.js shows running before its result', rerunning.length > 0 && rerunning[0].at <= (rec.of('file-result')[0]?.at ?? 0), JSON.stringify(rec.events.slice(0, 8)));
      t.eq('…and only it reran', [...new Set(results)], ['math.test.js']);
      const progress = rec.of('run-progress').pop();
      t.check('progress counted the file', progress && progress.total >= 1 && progress.completed === progress.total, JSON.stringify(progress));
      t.eq('math.test.js still passes', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
      const after = api.coverageStore.getEntry(key(mathJs));
      t.eq('math.js measured again (not stale)', after?.state, 'measured');
      t.check('…with the new uncalled function', after && after.pct.functions.total === 3 && after.pct.functions.covered === 2, JSON.stringify(after?.pct.functions));
      rec.stop();

      // ── A file no test imports: nothing reruns ──
      rec = h.recordEvents(api);
      since = h.isoNow();
      await h.editAndSave(vscode, untested, (s) => s + '\n// touched\n');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      t.check('untested.js: "no tests depend on this file"', logs.some((l) => /save untested\.js — no tests depend on this file/.test(l)), logs.join('\n'));
      t.eq('…no file reran', rec.of('file-result').length, 0);
      t.check('…no warning', !logs.some((l) => /\bWARN|\[warning\]/i.test(l) && /Vitest/.test(l)), logs.join('\n'));
      rec.stop();

      // ── The Vitest config: the session restarts ──
      rec = h.recordEvents(api);
      since = h.isoNow();
      await h.editAndSave(vscode, config, (s) => s + '\n// touched\n');
      await waitIdle(api);
      await h.waitFor(() => rec.of('run-finished').length > 0, { what: 'the restarted full run', timeout: 120_000 });
      logs = h.logsSince(api, since);
      t.check('saving vitest.config.mjs restarts the session', logs.some((l) => /vitest\.config\.mjs — the Vitest config changed, restarting/.test(l)), logs.join('\n'));
      const started = rec.of('run-started');
      t.check('…and every test file reruns', started.length === 1 && started[0].fileCount > 3, JSON.stringify(started));
      t.eq('…math.test.js passes after it', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
      rec.stop();
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const [f, s] of originals) { fs.writeFileSync(f, s); }
    }
  },
};
