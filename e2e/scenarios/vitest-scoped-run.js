'use strict';
/**
 * Scoped reruns on a Vitest project: one test, one suite, a test.each
 * template — each runs with a -t pattern for exactly that scope, updates
 * only those tests, and leaves everything else as it was.
 */
const h = require('../lib/harness');

const FILE = 'src/math.test.js';

async function rerun(api, vscode, node) {
  const mark = h.rawMark(api);
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', {
    scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName,
  });
  return h.rawSince(api, mark).filter((l) => /^\[vitest#\d+\] > /.test(l));
}

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const before = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));

    {
      const node = h.nodeByName(api, FILE, 'Math utils divide throws on zero');
      const cmds = await rerun(api, vscode, node);
      t.check('test: one Vitest run of math.test.js with a -t pattern', cmds.length === 1 && / run .*math\.test\.js/.test(cmds[0]) &&
        cmds[0].includes('^(?:Math(?: > | )utils(?: > | )divide(?: > | )throws(?: > | )on(?: > | )zero)$'), cmds.join('\n'));
      t.eq('test: still passed', api.store.getNode(node.id).status, 'passed');
    }
    {
      const node = h.nodeByName(api, FILE, 'Math utils divide');
      const cmds = await rerun(api, vscode, node);
      t.check('suite: pattern ends with the suite separator', cmds.some((l) => l.includes('^(?:Math(?: > | )utils(?: > | )divide)(?: > | |$)')), cmds.join('\n'));
      t.eq('suite: its tests passed', h.nodeByName(api, FILE, 'Math utils divide divides').status, 'passed');
    }
    {
      const tpl = h.allNodes(api).find((n) => n.isDynamicTemplate && n.name === 'add(%i, %i) = %i');
      const cmds = await rerun(api, vscode, tpl);
      t.check('test.each template: placeholders become .*', cmds.some((l) => / -t /.test(l) && l.includes('add\\\\(.*,(?: > | ).*\\\\)')), cmds.join('\n'));
      t.eq('test.each rows still passed', h.nodeByName(api, FILE, 'Math utils add(2, 3) = 5').status, 'passed');
    }

    const after = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));
    const changed = Object.keys(before).filter((id) => before[id] !== after[id]);
    t.eq('scoped reruns left every other result untouched', changed, []);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.eq('skipped / todo tests are still skipped (not overwritten by the pattern run)',
      [h.nodeByName(api, FILE, 'Math utils skipped test').status, h.nodeByName(api, FILE, 'Math utils todo test').status], ['skipped', 'skipped']);
  },
};
