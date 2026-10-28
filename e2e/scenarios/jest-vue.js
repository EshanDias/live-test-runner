'use strict';
/**
 * Any UI framework (Jest): Vue single-file components compiled by the
 * project's own transformer (@vue/vue3-jest).
 *   - results match plain Jest;
 *   - covering tests at the component's own lines (through vue-jest's map);
 *   - coverage of the component (our transform measures Jest coverage), and
 *     an untested component counts from its <script> block;
 *   - template lines get covering tests (the render function marks them),
 *     coverage stays what `jest --coverage` counts;
 *   - saving a .vue file reruns only the tests that ran it — before, saves
 *     of component files were ignored;
 *   - a file type the project's Jest config adds (`moduleFileExtensions`:
 *     html, with its own transform) reruns its tests on save.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}

async function hoverText(vscode, file, line0, col = 6) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line0, col));
  return (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}

module.exports = {
  workspace: 'fixture:jest-vue',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const counter = path.join(workspace, 'src', 'Counter.vue');
    const unused = path.join(workspace, 'src', 'Unused.vue');
    const text = path.join(workspace, 'src', 'text.js');
    const original = fs.readFileSync(counter, 'utf8');
    const before = fs.readdirSync(workspace).sort();
    try {
      await h.waitForDiscovery(api);
      let since = h.isoNow();
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      let logs = h.logsSince(api, since);
      h.checkMatchesPlainJest(api, t, workspace);
      t.check('no instrumentation warning for Counter.vue', !logs.some((l) => /Counter\.vue.*(without coverage|could not instrument)/.test(l)),
        logs.filter((l) => /vue/i.test(l)).join('\n'));

      // ── Covering tests at the component's own lines ──
      const names = (file, line) => api.traceStore.getTestsForLine(key(file), line).map((e) => e.fullName).sort();
      t.eq('Counter.vue line 22 (this.count += 1) is covered by "counter counts" only', names(counter, 22), ['counter counts']);
      t.eq('Counter.vue line 17 (computed label) by both counter tests', names(counter, 17), ['counter counts', 'counter starts at zero']);
      t.eq('text.js is used by both test files',
        api.traceStore.getAffectedTestFiles(key(text)).map((f) => path.basename(f)).sort(), ['counter.test.js', 'text.test.js']);
      t.eq('Counter.vue template line 2 (<button …>) by both counter tests — the render function ran it', names(counter, 2), ['counter counts', 'counter starts at zero']);
      const hover = await hoverText(vscode, counter, 21);
      t.check('hover on Counter.vue line 22: "Covered by 1 test" naming it', /Covered by 1 test/.test(hover) && /counter counts/.test(hover), hover);

      // ── Coverage ──
      await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'the source scan', timeout: 60_000 });
      const cov = api.coverageStore.getEntry(key(counter));
      t.check('Counter.vue is measured: its script statements and functions, all covered',
        cov && cov.state === 'measured' && cov.pct.statements.total >= 3 && cov.pct.statements.covered === cov.pct.statements.total && cov.pct.functions.covered === 3,
        JSON.stringify(cov && { state: cov.state, pct: cov.pct }));
      const un = api.coverageStore.getEntry(key(unused));
      t.check('the untested Unused.vue counts with 0 coverage (from its <script> block)',
        un && un.state === 'counted' && un.statements > 0, JSON.stringify(un));

      // ── Saving the component reruns only its test file ──
      const rec = h.recordEvents(api);
      since = h.isoNow();
      await h.editAndSave(vscode, counter, (s) => s + '\n<!-- touched -->\n');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      t.check('saving Counter.vue: a trace-based rerun', logs.some((l) => /Trace-based rerun for Counter\.vue/.test(l)), logs.join('\n'));
      t.eq('…only counter.test.js got a result', [...new Set(rec.of('file-result').map((e) => e.file))], ['counter.test.js']);
      t.eq('…still passing', h.statusCounts(api, 'src/counter.test.js'), { passed: 2 });
      rec.stop();

      // ── A file type the project's Jest config adds (moduleFileExtensions: html) ──
      const html = path.join(workspace, 'src', 'greeting.html');
      const htmlOriginal = fs.readFileSync(html, 'utf8');
      try {
        const rec2 = h.recordEvents(api);
        await h.editAndSave(vscode, html, (s) => s + '\n<!-- touched -->\n');
        await waitIdle(api);
        t.eq('saving greeting.html (html in moduleFileExtensions) reruns the test that loads it', [...new Set(rec2.of('file-result').map((e) => e.file))], ['html.test.js']);
        rec2.stop();
      } finally {
        fs.writeFileSync(html, htmlOriginal);
      }

      t.eq('nothing written into the project', fs.readdirSync(workspace).sort(), before);
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      fs.writeFileSync(counter, original);
    }
  },
};
