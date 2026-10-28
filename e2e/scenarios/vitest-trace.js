'use strict';
/**
 * Vitest execution trace (phase 9, ADR-9) on a Vitest 3.2 project with two
 * projects (an inline one and a folder with its own config):
 *   - results match plain Vitest (the wrapper config changes nothing a test sees:
 *     `test.extend` fixtures, a function serialised with toString());
 *   - covering tests per line, from both projects, TypeScript lines exact;
 *   - the coverage hover lists them;
 *   - saving a source file reruns only the tests that ran it (by name, `-t`);
 *   - the wrapper config writes nothing into the project;
 *   - fallback: a wrapper that breaks the run → the batch reruns as configured,
 *     results are complete, the trace is off for the project and saves use
 *     `vitest related`.
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

async function hoverText(vscode, file, line0) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line0, 4));
  return (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
}

module.exports = {
  workspace: 'fixture:vitest-trace',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const price = path.join(workspace, 'src', 'price.ts');
    const format = path.join(workspace, 'src', 'format.js');
    const util = path.join(workspace, 'packages', 'lib', 'src', 'util.js');
    const originals = new Map([price, format].map((f) => [f, fs.readFileSync(f, 'utf8')]));
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
      t.eq('cart.test.ts passes (incl. the serialised function)', h.statusCounts(api, 'src/cart.test.ts'), { passed: 3 });
      t.eq('fixture.test.ts passes (test.extend fixture)', h.statusCounts(api, 'src/fixture.test.ts'), { passed: 1 });
      t.eq('the folder project\'s test passes', h.statusCounts(api, 'packages/lib/src/util.test.js'), { passed: 1 });

      // ── Covering tests ──
      const names = (file, line) => api.traceStore.getTestsForLine(key(file), line).map((e) => e.fullName).sort();
      t.eq('price.ts line 4 (sum += item) is covered by "cart totals" only', names(price, 4), ['cart totals']);
      t.eq('price.ts line 9 (withTax) by the fixture test', names(price, 9), ['taxes a fixture amount']);
      t.eq('format.js line 2 by "cart formats"', names(format, 2), ['cart formats']);
      t.eq('the folder project\'s util.js line 2 by "doubles"', names(util, 2), ['doubles']);
      t.eq('price.ts is used by cart.test.ts and fixture.test.ts',
        api.traceStore.getAffectedTestFiles(key(price)).map((f) => path.basename(f)).sort(), ['cart.test.ts', 'fixture.test.ts']);

      const hover = await hoverText(vscode, price, 3);
      t.check('hover on price.ts line 4: "Covered by 1 test" naming it', /Covered by 1 test/.test(hover) && /cart totals/.test(hover), hover);

      // ── A source file save reruns only the tests that ran it ──
      let rec = h.recordEvents(api);
      since = h.isoNow();
      mark = h.rawMark(api);
      await h.editAndSave(vscode, format, (s) => s + '\n// touched\n');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      cmds = vitestCmds(h.rawSince(api, mark));
      t.check('saving format.js: a trace-based rerun of one test', logs.some((l) => /Trace-based rerun for format\.js: 0 whole file\(s\), 1 individual test\(s\)/.test(l)), logs.join('\n'));
      t.check('…by name (-t), not `vitest related`', cmds.some((l) => / -t /.test(l) && /cart\.test\.ts/.test(l)) && !cmds.some((l) => / related /.test(l)), cmds.join('\n'));
      t.eq('…only cart.test.ts got a result', [...new Set(rec.of('file-result').map((e) => e.file))], ['cart.test.ts']);
      t.eq('…still all passing', h.statusCounts(api, 'src/cart.test.ts'), { passed: 3 });
      rec.stop();

      t.eq('nothing written into the project', fs.readdirSync(workspace).sort(), before);

      // ── Fallback: the wrapper breaks the run ──
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      process.env.LTR_E2E_BREAK_TRACE_WRAPPER = '1';
      since = h.isoNow();
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      t.check('a broken wrapper: one WARN says the trace is off and why', logs.filter((l) => /\[warn\].*Vitest execution trace is off for .*: Vitest produced no results with the trace wrapper config/.test(l)).length === 1, logs.join('\n'));
      t.check('…and the batch is not given up (no plain-Vitest fallback)', !logs.some((l) => /falling back to plain Vitest/.test(l)), logs.join('\n'));
      h.checkMatchesPlainVitest(api, t, workspace, 'results still match plain Vitest');

      rec = h.recordEvents(api);
      since = h.isoNow();
      mark = h.rawMark(api);
      await h.editAndSave(vscode, price, (s) => s + '\n// touched\n');
      await waitIdle(api);
      cmds = vitestCmds(h.rawSince(api, mark));
      t.check('…a source save then uses `vitest related`', cmds.some((l) => / related .*price\.ts/.test(l)), cmds.join('\n'));
      t.check('…and runs no traced batch', !cmds.some((l) => /ltr\.vitest\.config\.mjs/.test(l)), cmds.join('\n'));
      t.eq('…rerunning both files that import it', [...new Set(rec.of('file-result').map((e) => e.file))].sort(), ['cart.test.ts', 'fixture.test.ts']);
      rec.stop();
      const offHover = await hoverText(vscode, format, 1);
      t.check('hover says why there are no covering tests', /covering tests are off for this project — .*no results/.test(offHover), offHover);
    } finally {
      delete process.env.LTR_E2E_BREAK_TRACE_WRAPPER;
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const [f, s] of originals) { fs.writeFileSync(f, s); }
    }
  },
};
