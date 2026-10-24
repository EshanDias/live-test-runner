'use strict';
/**
 * Any UI framework (Vitest): Vue and Svelte single-file components compiled
 * by their Vite plugins.
 *   - results match plain Vitest, with the trace wrapper config;
 *   - covering tests per component line (script and template), and the hover
 *     on a .vue file lists them;
 *   - Vitest's coverage reaches the components;
 *   - saving a .vue / .svelte file reruns only the tests that ran it (trace,
 *     not `vitest related`) — before, component saves were ignored;
 *   - nothing is written into the project.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());
const vitestCmds = (lines) => lines.filter((l) => /^\[vitest#\d+\] > /.test(l));

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}

async function hoverText(vscode, file, line0, col = 4) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line0, col));
  return (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}

module.exports = {
  workspace: 'fixture:vitest-components',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const counter = path.join(workspace, 'src', 'Counter.vue');
    const greeting = path.join(workspace, 'src', 'Greeting.svelte');
    const text = path.join(workspace, 'src', 'text.ts');
    const originals = new Map([counter, greeting].map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const before = fs.readdirSync(workspace).sort();
    try {
      await h.waitForDiscovery(api);
      let since = h.isoNow();
      let mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      let logs = h.logsSince(api, since);
      let cmds = vitestCmds(h.rawSince(api, mark));
      t.check('the batch runs with the trace wrapper config', cmds.some((l) => /--config .*ltr\.vitest\.config\.mjs/.test(l)), cmds.join('\n'));
      t.check('no trace warning', !logs.some((l) => /execution trace is off/.test(l)), logs.filter((l) => /trace/i.test(l)).join('\n'));
      h.checkMatchesPlainVitest(api, t, workspace);
      t.eq('counter.test.ts passes', h.statusCounts(api, 'src/counter.test.ts'), { passed: 2 });
      t.eq('greeting.test.ts passes', h.statusCounts(api, 'src/greeting.test.ts'), { passed: 1 });

      // ── Covering tests, at the components' own lines ──
      const names = (file, line) => api.traceStore.getTestsForLine(key(file), line).map((e) => e.fullName).sort();
      t.eq('Counter.vue line 14 (count.value += 1) is covered by "counter counts" only', names(counter, 14), ['counter counts']);
      t.eq('Counter.vue line 11 (computed label) by both counter tests', names(counter, 11), ['counter counts', 'counter starts at zero']);
      t.check('Counter.vue template lines are traced too (the render function)', [1, 2, 3, 4].some((l) => names(counter, l).length === 2),
        JSON.stringify([1, 2, 3, 4].map((l) => names(counter, l))));
      t.eq('Greeting.svelte line 5 (return …) by "greets loudly"', names(greeting, 5), ['greets loudly']);
      t.eq('text.ts is used by both test files',
        api.traceStore.getAffectedTestFiles(key(text)).map((f) => path.basename(f)).sort(), ['counter.test.ts', 'greeting.test.ts']);

      const hover = await hoverText(vscode, counter, 13);
      t.check('hover on Counter.vue line 14: "Covered by 1 test" naming it', /Covered by 1 test/.test(hover) && /counter counts/.test(hover), hover);

      // ── Coverage (Vitest's own) reaches the components ──
      await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'the source scan', timeout: 60_000 });
      for (const f of [counter, greeting]) {
        const cov = api.coverageStore.getEntry(key(f));
        t.check(`${path.basename(f)} is measured with statements covered`,
          cov && cov.state === 'measured' && cov.pct.statements.covered > 0, JSON.stringify(cov && { state: cov.state, pct: cov.pct }));
      }

      // ── Saving a component reruns only the tests that ran it ──
      for (const [file, testFile] of [[counter, 'counter.test.ts'], [greeting, 'greeting.test.ts']]) {
        const rec = h.recordEvents(api);
        since = h.isoNow();
        mark = h.rawMark(api);
        await h.editAndSave(vscode, file, (s) => s + '\n<!-- touched -->\n');
        await waitIdle(api);
        logs = h.logsSince(api, since);
        cmds = vitestCmds(h.rawSince(api, mark));
        const base = path.basename(file).replace('.', '\\.');
        t.check(`saving ${path.basename(file)}: a trace-based rerun`, logs.some((l) => new RegExp(`Trace-based rerun for ${base}`).test(l)), logs.join('\n'));
        t.check('…not `vitest related`', cmds.length > 0 && !cmds.some((l) => / related /.test(l)), cmds.join('\n'));
        t.eq(`…only ${testFile} got a result`, [...new Set(rec.of('file-result').map((e) => e.file))], [testFile]);
        rec.stop();
      }
      t.eq('…still all passing', [h.statusCounts(api, 'src/counter.test.ts'), h.statusCounts(api, 'src/greeting.test.ts')], [{ passed: 2 }, { passed: 1 }]);

      t.eq('nothing written into the project', fs.readdirSync(workspace).sort(), before);
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const [f, s] of originals) { fs.writeFileSync(f, s); }
    }
  },
};
