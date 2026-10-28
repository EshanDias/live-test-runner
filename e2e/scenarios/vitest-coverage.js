'use strict';
/**
 * Coverage on a Vitest project (@vitest/coverage-v8 installed): Vitest's own
 * coverage reaches the coverage store, gutter and hover; a source file no
 * test loads still counts (0 %) — the source scan works without the
 * project's Babel; nothing is written into the project.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'the source scan', timeout: 60_000 });
    const logs = h.logsSince(api, since);

    const mathJs = key(path.join(workspace, 'src', 'math.js'));
    const cov = api.coverageStore.getEntry(mathJs);
    t.eq('src/math.js is measured', cov?.state, 'measured');
    t.check('…all of its statements covered', cov && cov.pct.statements.total > 0 && cov.pct.statements.covered === cov.pct.statements.total, JSON.stringify(cov?.pct));
    t.check('…and its functions', cov && cov.pct.functions.covered === 2, JSON.stringify(cov?.pct));
    t.check('…with a manifest on disk (gutter / hover read it)', cov && fs.existsSync(cov.manifestPath), cov?.manifestPath);

    const untested = api.coverageStore.getEntry(key(path.join(workspace, 'src', 'untested.js')));
    t.check('an untested source file counts with 0 coverage (source scan without the project\'s Babel)',
      untested && untested.state === 'counted' && untested.statements > 0, JSON.stringify(untested));
    t.check('no "Could not load a Babel parser" warning', !logs.some((l) => /Could not load (a )?Babel/.test(l)), logs.filter((l) => /Babel/.test(l)).join('\n'));
    t.check('test files are not measured', !api.coverageStore.getEntry(key(path.join(workspace, 'src', 'math.test.js'))));

    const totals = api.coverageStore.getTotals();
    t.check('totals include the measured and the untested file', totals.statements.total > cov.pct.statements.total && totals.statements.covered > 0, JSON.stringify(totals));

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'src', 'math.js')));
    await vscode.window.showTextDocument(doc);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 4));
    const text = (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    t.check('hover: covered by the 3 tests that call add() (execution trace, phase 9)', /Covered by 3 tests/.test(text) && /adds numbers/.test(text), text);

    t.check('nothing written into the project (no coverage/ folder)', !fs.existsSync(path.join(workspace, 'coverage')));
  },
};
