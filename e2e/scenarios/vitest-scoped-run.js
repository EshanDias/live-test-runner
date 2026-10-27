'use strict';
/**
 * Scoped reruns on a Vitest project: one test, one suite, a test.each
 * template — each runs with a -t pattern for exactly that scope, updates
 * only those tests, and leaves everything else as it was.
 *
 * The config names its own report file (`outputFile: 'ci-report.xml'`, a
 * single path): that used to win over our `--outputFile.json=`, so a
 * failing test's scoped run read Vitest's printed output as its JSON
 * ("invalid JSON") and showed no result.
 */
const fs = require('fs');
const path = require('path');
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

  async run({ api, t, vscode, workspace }) {
    const configFile = path.join(workspace, 'vitest.config.mjs');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8')
      .replace("reporters: ['dot'],", "reporters: ['junit'],\n    outputFile: 'ci-report.xml',"));
    fs.writeFileSync(path.join(workspace, 'src', 'scoped-fail.test.js'), [
      "import { describe, it, expect } from 'vitest';",
      "describe('Scoped', () => {",
      "  it('passes', () => { expect(1).toBe(1); });",
      "  it('fails', () => { expect(1).toBe(2); });",
      '});',
      '',
    ].join('\n'));
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('scoped-fail.test.js')),
      { what: 'scoped-fail.test.js to be discovered', timeout: 30_000 });
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const before = Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));

    {
      const node = h.nodeByName(api, FILE, 'Math utils divide throws on zero');
      const cmds = await rerun(api, vscode, node);
      t.check('test: one Vitest run of math.test.js with a -t pattern', cmds.length === 1 && / run .*math\.test\.js/.test(cmds[0]) &&
        cmds[0].includes('^ ?(?:Math(?: > | )utils(?: > | )divide(?: > | )throws(?: > | )on(?: > | )zero)$'), cmds.join('\n'));
      t.eq('test: still passed', api.store.getNode(node.id).status, 'passed');
    }
    {
      const node = h.nodeByName(api, FILE, 'Math utils divide');
      const cmds = await rerun(api, vscode, node);
      t.check('suite: pattern ends with the suite separator', cmds.some((l) => l.includes('^ ?(?:Math(?: > | )utils(?: > | )divide)(?: > | |$)')), cmds.join('\n'));
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

    {
      const FAIL = 'src/scoped-fail.test.js';
      t.eq('failing test failed in the full run', h.nodeByName(api, FAIL, 'Scoped fails').status, 'failed');
      const node = h.nodeByName(api, FAIL, 'Scoped fails');
      await rerun(api, vscode, node);
      const after = api.store.getNode(node.id);
      t.eq('failing test (config outputFile): still failed after its own run', after.status, 'failed');
      t.check('failing test (config outputFile): its failure message is shown', (after.failureMessages || []).some((m) => /expected 1 to be 2/.test(m)),
        JSON.stringify(after.failureMessages));
      t.eq('failing test (config outputFile): the passing test beside it is untouched', h.nodeByName(api, FAIL, 'Scoped passes').status, 'passed');
      t.check('no "could not read Vitest\'s JSON" error', !api.logger.recentLines().some((l) => /Could not read Vitest's JSON/.test(l)));
      t.check("nothing written to the project's own report file", !fs.existsSync(path.join(workspace, 'ci-report.xml')));
    }
  },
};
