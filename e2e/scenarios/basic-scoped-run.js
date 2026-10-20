'use strict';
/**
 * ▶ Run on single tests and suites (BUG-03): the name pattern must reach Jest
 * intact — spaces, ^, |, & — and only the chosen scope may run.
 */
const h = require('../lib/harness');

const FILE = 'src/math.test.js';

async function rerun(api, vscode, node) {
  const mark = h.rawMark(api);
  await vscode.commands.executeCommand('liveTestRunner.rerunScope', {
    scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName,
  });
  const raw = h.rawSince(api, mark);
  return { raw, summaries: h.jestTestSummaries(raw) };
}

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const before = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));

    // A test whose name is full of cmd.exe metacharacters.
    {
      const node = h.nodeByName(api, FILE, 'Math utils a^b | c & d');
      const { raw, summaries } = await rerun(api, vscode, node);
      t.eq('BUG-03 "a^b | c & d": exactly one test ran', summaries.map((s) => s.passed), [1]);
      t.check('BUG-03 no cmd.exe errors', !raw.some((l) => /is not recognized as an internal or external command/.test(l)),
        raw.join('\n'));
      t.eq('BUG-03 "a^b | c & d" passed', api.store.getNode(node.id).status, 'passed');
    }

    // Same leaf name in two suites — only the chosen suite's test may run.
    {
      const node = h.nodeByName(api, FILE, 'Math utils adds numbers');
      const { summaries } = await rerun(api, vscode, node);
      t.eq('BUG-03 "Math utils adds numbers": exactly one test ran', summaries.map((s) => s.passed), [1]);
      const out = api.store.getNodeOutput(node.id).lines.map((l) => l.text);
      t.check('test-scoped output captured', out.some((l) => l.includes('adding ✓ ünïcödé')), JSON.stringify(out));
    }

    // A suite runs all of its tests and nothing from the other suite.
    {
      const node = h.nodeByName(api, FILE, 'Math utils');
      const { summaries } = await rerun(api, vscode, node);
      t.eq('BUG-03 suite "Math utils": its 4 runnable tests ran', summaries.map((s) => s.passed), [4]);
    }

    // Nothing else changed and nothing is left spinning.
    const after = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));
    const changed = Object.keys(before).filter((id) => before[id] !== after[id]);
    t.eq('scoped reruns left other results untouched', changed, []);
    t.eq('BUG-23 nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
  },
};
