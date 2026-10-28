'use strict';
/**
 * Scoped reruns on a pytest project: one test, a class, a parametrize
 * template (every case) and one case — each runs by node id (never -k),
 * updates only those tests, and leaves everything else as it was.
 */
const h = require('../lib/harness');

const FILE = 'tests/test_cart.py';

async function rerun(api, vscode, node) {
  const mark = h.rawMark(api);
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', {
    scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName,
  });
  return h.rawSince(api, mark).filter((l) => /^\[pytest#\d+\] > .* -m pytest /.test(l));
}

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const before = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));

    {
      const node = h.nodeByName(api, FILE, 'TestCart test_add');
      const cmds = await rerun(api, vscode, node);
      t.check('test: one pytest run with its node id', cmds.length === 1 && /tests[\\/]test_cart\.py::TestCart::test_add\b/.test(cmds[0]) && !/ -k /.test(cmds[0]), cmds.join('\n'));
      t.eq('test: still passed', api.store.getNode(node.id).status, 'passed');
    }
    {
      const node = h.nodeByName(api, FILE, 'TestCart');
      const cmds = await rerun(api, vscode, node);
      t.check('class: selected by its node id', cmds.some((l) => /tests[\\/]test_cart\.py::TestCart(\s|$)/.test(l)), cmds.join('\n'));
      t.eq('class: nested test still passed', h.nodeByName(api, FILE, 'TestCart TestNested test_inner').status, 'passed');
      t.eq('class: its failing test still failed', h.nodeByName(api, FILE, 'TestCart test_fails_on_purpose').status, 'failed');
    }
    {
      const tpl = h.allNodes(api).find((n) => n.isDynamicTemplate && n.fullName === 'test_discount[…]');
      const cmds = await rerun(api, vscode, tpl);
      t.check('parametrize template: the function, every case', cmds.some((l) => /tests[\\/]test_cart\.py::test_discount(\s|$)/.test(l)), cmds.join('\n'));
      t.eq('parametrize cases still passed', ['test_discount[HALF-50]', 'test_discount[TENOFF-90]', 'test_discount[NONE-100]'].map((n) => h.nodeByName(api, FILE, n)?.status),
        ['passed', 'passed', 'passed']);
    }
    {
      const node = h.nodeByName(api, FILE, 'TestCart test_rejects_bad_qty[-1]');
      const cmds = await rerun(api, vscode, node);
      t.check('one parametrize case: pivots to its template (all cases), like Jest .each', cmds.some((l) => /test_cart\.py::TestCart::test_rejects_bad_qty(\s|$)/.test(l)), cmds.join('\n'));
      t.eq('…both cases passed', [h.nodeByName(api, FILE, 'TestCart test_rejects_bad_qty[0]')?.status, api.store.getNode(node.id)?.status], ['passed', 'passed']);
    }

    const after = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));
    const changed = Object.keys(before).filter((id) => before[id] !== after[id]);
    t.eq('scoped reruns left every other result untouched', changed, []);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.eq('skipped / xfail tests are still skipped', [h.nodeByName(api, FILE, 'test_skipped').status, h.nodeByName(api, FILE, 'test_expected_failure').status], ['skipped', 'skipped']);
  },
};
