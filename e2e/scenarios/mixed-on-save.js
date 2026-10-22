'use strict';
/**
 * Saves in a mixed-framework project (phase 8): a saved test file reruns
 * with its own framework; a saved source file reruns the dependent tests of
 * both frameworks (Jest by its trace, Vitest with `vitest related`) and no
 * file gets the other framework's result; a file that starts importing
 * `vitest` moves to Vitest on save; saving the Vitest config restarts.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}

module.exports = {
  workspace: 'fixture:mixed-same-package',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const src = (n) => path.join(workspace, 'src', n);
    const files = ['mul.vitest.js', 'uses-jest.test.js', 'math.js', 'says-nothing.test.js'].map(src).concat(path.join(workspace, 'vitest.config.mjs'));
    const originals = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const ctx = api.projects.contexts[0];
    try {
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      t.eq('full run: uses-jest.test.js', h.statusCounts(api, 'uses-jest.test.js'), { passed: 1, failed: 1 });

      // ── A Vitest test file ──
      let rec = h.recordEvents(api);
      let mark = h.rawMark(api);
      await h.editAndSave(vscode, src('mul.vitest.js'), (s) => s + '\n// touched\n');
      await waitIdle(api);
      let raw = h.rawSince(api, mark).join('\n');
      t.eq('saved mul.vitest.js reruns only it', [...new Set(rec.of('file-result').map((e) => e.file))], ['mul.vitest.js']);
      t.check('…with Vitest', /\[vitest#\d+\]/.test(raw) && !/\[jest#\d+\]/.test(raw), raw.slice(0, 1500));
      t.eq('…still passes', h.statusCounts(api, 'mul.vitest.js'), { passed: 2 });
      rec.stop();

      // ── A Jest test file listed by both ──
      rec = h.recordEvents(api);
      mark = h.rawMark(api);
      await h.editAndSave(vscode, src('uses-jest.test.js'), (s) => s + '\n// touched\n');
      await waitIdle(api);
      raw = h.rawSince(api, mark).join('\n');
      t.eq('saved uses-jest.test.js reruns only it', [...new Set(rec.of('file-result').map((e) => e.file))], ['uses-jest.test.js']);
      t.check('…with Jest', /\[jest#\d+\]/.test(raw) && !/\[vitest#\d+\]/.test(raw), raw.slice(0, 1500));
      t.eq('…same results', h.statusCounts(api, 'uses-jest.test.js'), { passed: 1, failed: 1 });
      rec.stop();

      // ── The shared source file: both frameworks rerun their dependents ──
      rec = h.recordEvents(api);
      mark = h.rawMark(api);
      await h.editAndSave(vscode, src('math.js'), (s) => s.replace('module.exports', '// touched\nmodule.exports'));
      await waitIdle(api);
      raw = h.rawSince(api, mark).join('\n');
      const reran = new Set(rec.of('file-result').map((e) => e.file));
      t.check('saved math.js reruns Jest\'s dependents', reran.has('add.jest.js') && reran.has('uses-jest.test.js'), [...reran].join(', '));
      t.check('…and Vitest\'s', reran.has('mul.vitest.js') && reran.has('imports-vitest.test.js'), [...reran].join(', '));
      t.check('…not says-nothing.test.js (no import of math.js)', !reran.has('says-nothing.test.js'), [...reran].join(', '));
      t.check('…Vitest via vitest related', /\[vitest#\d+\] > .* related .*math\.js/.test(raw), raw.slice(0, 2000));
      t.eq('uses-jest.test.js kept Jest\'s result (Vitest\'s related run lists it too)', h.statusCounts(api, 'uses-jest.test.js'), { passed: 1, failed: 1 });
      t.eq('imports-vitest.test.js passes', h.statusCounts(api, 'imports-vitest.test.js'), { passed: 1 });
      t.eq('nothing left running', api.store.getAllFiles().filter((f) => f.status === 'running').map((f) => f.name), []);
      rec.stop();

      // ── A file starts importing vitest: it moves to Vitest ──
      const since = h.isoNow();
      mark = h.rawMark(api);
      await h.editAndSave(vscode, src('says-nothing.test.js'), () =>
        "import { describe, test, expect } from 'vitest';\n\ntest('framework-neutral', () => {\n  expect(typeof describe).toBe('function');\n});\n");
      await waitIdle(api);
      raw = h.rawSince(api, mark).join('\n');
      const logs = h.logsSince(api, since);
      t.check('says-nothing.test.js now runs with Vitest', logs.some((l) => /says-nothing\.test\.js now runs with Vitest/.test(l)), logs.join('\n'));
      t.check('…its rerun is a Vitest run', /\[vitest#\d+\]/.test(raw) && !/\[jest#\d+\]/.test(raw), raw.slice(0, 1500));
      t.eq('…and it passes there', h.statusCounts(api, 'says-nothing.test.js'), { passed: 1 });
      t.eq('…the router agrees', Object.entries(ctx.services.frameworksByFile()).find(([f]) => f.endsWith('says-nothing.test.js'))?.[1], 'vitest');

      // ── The Vitest config of a mixed project: the session restarts ──
      rec = h.recordEvents(api);
      const since2 = h.isoNow();
      await h.editAndSave(vscode, path.join(workspace, 'vitest.config.mjs'), (s) => s + '\n// touched\n');
      await waitIdle(api);
      await h.waitFor(() => rec.of('run-finished').length > 0, { what: 'the restarted run', timeout: 120_000 });
      const logs2 = h.logsSince(api, since2);
      t.check('saving vitest.config.mjs restarts the session', logs2.some((l) => /vitest\.config\.mjs — the Vitest config changed, restarting/.test(l)), logs2.join('\n'));
      t.eq('…every file reruns', rec.of('run-started')[0]?.fileCount, 5);
      rec.stop();
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const [f, s] of originals) { fs.writeFileSync(f, s); }
    }
  },
};
