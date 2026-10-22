'use strict';
/**
 * Mixed-framework project (phase 8): a Jest root with its own Vitest config.
 * Every test file runs with exactly one framework — the one whose own list
 * holds it, else what the file uses (a `vitest` import, a `jest.` call),
 * else Jest (the main framework) with one WARN naming the setting (D13).
 * The results prove where each file ran: imports-vitest.test.js only passes
 * under Vitest, uses-jest.test.js only under Jest. The Explorer groups by
 * framework, the status bar splits the counts, math.js (loaded by Jest and
 * Vitest tests) shows the coverage of both, ▶ Run uses the file's framework.
 */
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());
/** Object with sorted keys (t.eq compares JSON). */
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

module.exports = {
  workspace: 'fixture:mixed-same-package',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const ctx = api.projects.contexts[0];
    t.eq('one project', api.projects.contexts.length, 1);
    t.eq('…labelled jest + vitest before any run', ctx.frameworkLabel, 'jest + vitest');

    await h.waitForDiscovery(api);
    const since = h.isoNow();
    try {
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 180_000 });
      const logs = h.logsSince(api, since);

      const byName = {};
      for (const [file, fw] of Object.entries(ctx.services.frameworksByFile())) { byName[path.basename(file)] = fw; }
      t.eq('each file has one framework', sorted(byName), sorted({
        'add.jest.js': 'jest',
        'uses-jest.test.js': 'jest',
        'says-nothing.test.js': 'jest',
        'imports-vitest.test.js': 'vitest',
        'mul.vitest.js': 'vitest',
      }));

      t.eq('add.jest.js (Jest only)', h.statusCounts(api, 'add.jest.js'), { passed: 2 });
      t.eq('mul.vitest.js (Vitest only)', h.statusCounts(api, 'mul.vitest.js'), { passed: 2 });
      t.eq('imports-vitest.test.js ran with Vitest (fails under Jest)', h.statusCounts(api, 'imports-vitest.test.js'), { passed: 1 });
      t.eq('uses-jest.test.js ran with Jest (jest.fn)', h.statusCounts(api, 'uses-jest.test.js'), { passed: 1, failed: 1 });
      t.eq('says-nothing.test.js ran with Jest (the main framework)', h.statusCounts(api, 'says-nothing.test.js'), { passed: 1 });
      t.eq('no file excluded', api.store.getAllFiles().filter((f) => f.excluded).map((f) => f.name), []);

      const groups = Object.fromEntries(api.store.getAllFiles().map((f) => [path.basename(f.filePath), f.group]));
      t.eq('the Explorer groups files by framework', sorted(groups), sorted({
        'add.jest.js': 'Jest', 'uses-jest.test.js': 'Jest', 'says-nothing.test.js': 'Jest',
        'imports-vitest.test.js': 'Vitest', 'mul.vitest.js': 'Vitest',
      }));
      const logsNow = h.logsSince(api, since);
      t.check('every file got a batch result (no plain-run fallback)', !logsNow.some((l) => /No result for|falling back to plain/.test(l)), logsNow.join('\n'));

      t.check('INFO names the mixed project and its split', logs.some((l) => /mixed Jest \+ Vitest project \(jest\.config\.js and vitest\.config\.mjs\) — Jest runs 3 test file\(s\), Vitest 2/.test(l)), logs.join('\n'));
      const warns = logs.filter((l) => /match both the Jest and the Vitest config/.test(l));
      t.eq('one WARN for the file nothing settles (D13)', warns.length, 1);
      t.check('…naming the file and the setting', /says-nothing\.test\.js/.test(warns[0] ?? '') && /liveTestRunner\.frameworks/.test(warns[0] ?? ''), warns.join('\n'));
      t.check('Session started line says jest + vitest', logs.some((l) => /Session started — 5 test file\(s\) · framework: jest \+ vitest/.test(l)), logs.join('\n'));
      t.check('status bar splits the tests per framework', / · Jest 5 · Vitest 3$/.test(api.statusBar.text), api.statusBar.text);

      const raw = api.rawOutput.join('\n');
      t.check('Jest and Vitest both ran', /\[jest#\d+\]/.test(raw) && /\[vitest#\d+\]/.test(raw));

      const math = api.coverageStore.getEntry(key(path.join(workspace, 'src', 'math.js')));
      t.eq('math.js measured', math?.state, 'measured');
      t.check('…add (Jest) and mul (Vitest) both covered, neverCalled not', math && math.pct.functions.covered === 2 && math.pct.functions.total === 3, JSON.stringify(math?.pct.functions));

      // ── ▶ Run one test: its file's framework ──
      const mark = h.rawMark(api);
      const node = h.nodeByName(api, 'mul.vitest.js', 'mul (Vitest) multiplies');
      await api.session.rerunScope({ scope: 'test', fileId: h.fileBySuffix(api, 'mul.vitest.js').fileId, nodeId: node.id, fullName: node.fullName });
      const runRaw = h.rawSince(api, mark).join('\n');
      t.check('▶ Run on a Vitest test runs Vitest', /\[vitest#\d+\]/.test(runRaw) && !/\[jest#\d+\]/.test(runRaw), runRaw.slice(0, 2000));
      t.eq('…and it passes', h.nodeByName(api, 'mul.vitest.js', 'mul (Vitest) multiplies').status, 'passed');
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
    await h.sleep(2000);
    const left = h.jestProcesses(workspace).concat(h.vitestProcesses(workspace));
    t.check('no process left', left.length === 0, left.join('\n'));
  },
};
