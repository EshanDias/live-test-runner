'use strict';
/**
 * Explorer "Running" card: the Explorer is told how many tests are running
 * while a run is in flight (the card shows), and 0 once it is over (the card
 * hides and a "running" filter falls back to "all"). The webview DOM is not
 * reachable from the extension host, so this checks the counts the Explorer
 * view is sent (`runningTests`) next to the ResultStore's own count.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

/** Records what the Explorer view is sent. */
function recordExplorer(api) {
  const view = api.explorerView;
  const sent = [];
  const original = view.postMessage.bind(view);
  view.postMessage = (msg) => { sent.push(msg); return original(msg); };
  return { sent, restore: () => { view.postMessage = original; } };
}

const counts = (sent) => sent.filter((m) => typeof m.runningTests === 'number').map((m) => [m.type, m.runningTests]);

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    // Two tests that take a few seconds, so the run is observable mid-flight.
    fs.writeFileSync(path.join(workspace, 'src', 'slowcount.test.js'),
      "const wait = () => new Promise((r) => setTimeout(r, 4000));\n" +
      "test('slow one', wait, 30000);\ntest('slow two', wait, 30000);\n");
    await h.waitForDiscovery(api);
    await h.waitFor(() => api.store.getAllFiles().some((f) => f.filePath.endsWith('slowcount.test.js')),
      { what: 'slowcount.test.js to be discovered', timeout: 30_000 });

    // ── Full run ────────────────────────────────────────────────────────────
    {
      const rec = recordExplorer(api);
      let peak = 0;
      try {
        const start = vscode.commands.executeCommand('liveTestRunner.startTesting');
        await h.waitFor(() => { peak = Math.max(peak, api.store.getSummary().running); return peak > 0; },
          { what: 'tests to be running', timeout: 60_000, interval: 50 });
        await h.waitFor(() => rec.sent.some((m) => m.runningTests > 0),
          { what: 'the Explorer to be sent a running count', timeout: 10_000 });
        await start;
        await h.sleep(500); // trailing batched results
      } finally { rec.restore(); }
      const sent = counts(rec.sent);
      t.check('full run: the store counted running tests mid-run', peak > 0, `peak ${peak}`);
      t.check('full run: the Explorer was sent a running count > 0 (card shown)', sent.some(([, n]) => n > 0), JSON.stringify(sent).slice(0, 400));
      t.eq('full run: nothing running in the store afterwards', api.store.getSummary().running, 0);
      const finished = rec.sent.filter((m) => m.type === 'run-finished');
      t.check('full run: run-finished carries runningTests 0 (card hidden)', finished.length > 0 && finished.every((m) => m.runningTests === 0),
        JSON.stringify(finished.map((m) => m.runningTests)));
      t.eq('full run: the last count sent is 0', sent.length ? sent[sent.length - 1][1] : null, 0);
    }

    // ── Scoped rerun of one test: the card comes back with 1, then goes ───────
    {
      const node = h.nodeByName(api, 'src/slowcount.test.js', 'slow one');
      const rec = recordExplorer(api);
      try {
        await vscode.commands.executeCommand('liveTestRunner.rerunScope', {
          scope: node.type, fileId: node.fileId, nodeId: node.id, fullName: node.fullName,
        });
        await h.sleep(500);
      } finally { rec.restore(); }
      const sent = counts(rec.sent);
      const rerunning = rec.sent.find((m) => m.type === 'files-rerunning');
      t.eq('rerun: the Explorer is told exactly 1 test is running', rerunning && rerunning.runningTests, 1);
      t.eq('rerun: the last count sent is 0', sent.length ? sent[sent.length - 1][1] : null, 0);
      t.eq('rerun: nothing running in the store afterwards', api.store.getSummary().running, 0);
    }

    // ── A newly shown Explorer (init) gets the count too ────────────────────
    {
      const rec = recordExplorer(api);
      try { api.explorerView.syncNow(); } finally { rec.restore(); }
      const init = rec.sent.find((m) => m.type === 'init');
      t.eq('init: carries runningTests 0 when idle', init && init.runningTests, 0);
    }
  },
};
