'use strict';
/**
 * Covering tests and source-file saves on a pytest project. Each test runs in
 * its own coverage.py context, so after Start:
 *  - the coverage hover lists the tests that ran a line;
 *  - saving a source file reruns exactly the tests that ran it, by node id
 *    (src/shop/pricing.py: only test_with_tax — its neighbour in the same file
 *    never calls it);
 *  - a module the tests import but never run (src/shop/labels.py) is found
 *    through the import graph: the importing test file reruns whole;
 *  - a module nothing imports reruns nothing.
 * Every saved file is restored to its exact content.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

async function idle(api) {
  await h.sleep(1500);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
}

async function saveTouch(api, vscode, file) {
  const original = fs.readFileSync(file);
  const mark = h.rawMark(api);
  try {
    await h.editAndSave(vscode, file, (text) => text + '\n');
    await idle(api);
  } finally {
    fs.writeFileSync(file, original);
  }
  return h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
}

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,
  settings: { 'liveTestRunner.onSaveDebounceMs': 100 },

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');

    // Hover: the tests that ran `return round(amount * 1.2, 2)`.
    const pricing = path.join(workspace, 'src', 'shop', 'pricing.py');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pricing));
    await vscode.window.showTextDocument(doc);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(1, 6));
    const text = (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    t.check('hover: covered by test_with_tax', /Covered by 1 test/.test(text) && /test_with_tax/.test(text), text);
    t.check('…and not by its neighbour', !/test_without_pricing/.test(text), text);

    const before = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));
    let cmds = await saveTouch(api, vscode, pricing);
    t.check('saving pricing.py reruns only test_with_tax, by node id',
      cmds.length === 1 && /test_pricing\.py::test_with_tax\b/.test(cmds[0]) && !/test_without_pricing/.test(cmds[0]), cmds.join('\n'));
    t.eq('…which passes again', h.nodeByName(api, 'tests/test_pricing.py', 'test_with_tax')?.status, 'passed');

    cmds = await saveTouch(api, vscode, path.join(workspace, 'src', 'shop', 'labels.py'));
    t.check('saving labels.py (imported, never run by a test) reruns the importing test file whole',
      cmds.length === 1 && /test_pricing\.py(\s|$)/.test(cmds[0]) && !/::/.test(cmds[0]), cmds.join('\n'));

    const since = h.isoNow();
    cmds = await saveTouch(api, vscode, path.join(workspace, 'src', 'shop', 'untested.py'));
    t.eq('saving untested.py (nothing imports it) reruns nothing', cmds, []);
    t.check('…and says so', h.logsSince(api, since).some((l) => /no tests depend on this file/.test(l)), h.logsSince(api, since).join('\n'));

    const after = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));
    const changed = Object.keys(before).filter((id) => before[id] !== after[id]);
    t.eq('the reruns changed no other result', changed, []);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
