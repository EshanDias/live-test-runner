'use strict';
/**
 * Vitest 3.1 workspace (a `vitest.workspace.ts` next to the config) with an
 * inline project and a folder project, plus a type-check file
 * (`typecheck.enabled`, *.test-d.ts):
 *   - the execution trace reaches both projects (before: off for the whole
 *     project, with an INFO line);
 *   - the type-check file does not turn the trace off (it never runs a worker);
 *   - results match plain Vitest;
 *   - saving a source file is a trace-based rerun, not `vitest related`;
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

module.exports = {
  workspace: 'fixture:vitest-workspace',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const price = path.join(workspace, 'src', 'price.ts');
    const util = path.join(workspace, 'packages', 'lib', 'src', 'util.js');
    const originals = new Map([price, util].map((f) => [f, fs.readFileSync(f, 'utf8')]));
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
      t.check('the trace stays on (workspace file and type-check file)', !logs.some((l) => /execution trace is off/.test(l)), logs.filter((l) => /trace/i.test(l)).join('\n'));
      h.checkMatchesPlainVitest(api, t, workspace);
      t.eq('price.test.ts passes (inline project)', h.statusCounts(api, 'src/price.test.ts'), { passed: 2 });
      t.eq('util.test.js passes (folder project)', h.statusCounts(api, 'packages/lib/src/util.test.js'), { passed: 1 });

      const names = (file, line) => api.traceStore.getTestsForLine(key(file), line).map((e) => e.fullName).sort();
      t.eq('price.ts line 4 (sum += i) is covered by "totals"', names(price, 4), ['totals']);
      t.eq('price.ts line 10 (withTax) by "taxes"', names(price, 10), ['taxes']);
      t.eq('the folder project\'s util.js line 2 by "doubles"', names(util, 2), ['doubles']);

      // ── A source save is a trace-based rerun ──
      for (const [file, testFile] of [[price, 'price.test.ts'], [util, 'util.test.js']]) {
        const rec = h.recordEvents(api);
        since = h.isoNow();
        mark = h.rawMark(api);
        await h.editAndSave(vscode, file, (s) => s + '\n// touched\n');
        await waitIdle(api);
        logs = h.logsSince(api, since);
        cmds = vitestCmds(h.rawSince(api, mark));
        const base = path.basename(file).replace('.', '\\.');
        t.check(`saving ${path.basename(file)}: a trace-based rerun`, logs.some((l) => new RegExp(`Trace-based rerun for ${base}`).test(l)), logs.join('\n'));
        t.check('…not `vitest related`', cmds.length > 0 && !cmds.some((l) => / related /.test(l)), cmds.join('\n'));
        t.eq(`…${testFile} got a result`, [...new Set(rec.of('file-result').map((e) => e.file))].filter((f) => f === testFile), [testFile]);
        rec.stop();
      }
      t.check('…the trace is still on', !h.logsSince(api, since).some((l) => /execution trace is off/.test(l)));

      t.eq('nothing written into the project', fs.readdirSync(workspace).sort(), before);
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      for (const [f, s] of originals) { fs.writeFileSync(f, s); }
    }
  },
};
