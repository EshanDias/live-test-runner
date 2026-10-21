'use strict';
/**
 * Live progress on a Vitest project: a file shows running only once Vitest
 * starts it, and each file's result arrives when that file finishes — the
 * fast files are done while a slow file in the same batch still runs.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    fs.writeFileSync(path.join(workspace, 'src', 'slow.test.js'),
      "import { test } from 'vitest';\ntest('takes ten seconds', () => new Promise((r) => setTimeout(r, 10000)), 30000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slow.test.js')),
      { what: 'slow.test.js to be discovered', timeout: 30_000 });

    const rec = h.recordEvents(api);
    const full = vscode.commands.executeCommand('liveTestRunner.startTesting');

    // While slow.test.js runs, the other files of its batch already have results.
    await h.waitFor(() => h.fileBySuffix(api, 'src/slow.test.js').status === 'running', { what: 'slow.test.js to start', timeout: 60_000 });
    await h.waitFor(() => h.fileBySuffix(api, 'src/math.test.js').status === 'passed', { what: 'math.test.js to finish', timeout: 30_000 });
    t.eq('math.test.js has its result while slow.test.js is still running', h.fileBySuffix(api, 'src/slow.test.js').status, 'running');
    const progress = rec.of('run-progress');
    t.check('progress was reported per file during the run', progress.some((p) => p.completed > 0 && p.completed < p.total), JSON.stringify(progress.slice(0, 8)));

    await full;
    t.eq('slow.test.js passed in the end', h.statusCounts(api, 'src/slow.test.js'), { passed: 1 });
    t.eq('math.test.js results', h.statusCounts(api, 'src/math.test.js'), { passed: 5, skipped: 2 });
    t.eq('one run-finished', rec.of('run-finished').length, 1);
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);
    t.check('per-test output still attributed', api.store.getNodeOutput(h.nodeByName(api, 'src/math.test.js', 'Math utils adds numbers').id).lines.some((l) => l.text.includes('adding ✓ ünïcödé')));
    rec.stop();
  },
};
