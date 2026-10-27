'use strict';
/**
 * Clear Cache and Restart Testing: stops the session, clears results and the
 * discovery cache, resyncs the views, rediscovers, and starts a new session
 * that runs everything (it used to stop after rediscovery, with the views
 * still showing the old list and Start). Stop and Clear Cache: the same
 * without the restart.
 */
const h = require('../lib/harness');

/** Records what the Explorer view is sent. */
function recordExplorer(api) {
  const view = api.explorerView;
  const sent = [];
  const original = view.postMessage.bind(view);
  view.postMessage = (msg) => { sent.push(msg); return original(msg); };
  return { sent, restore: () => { view.postMessage = original; } };
}

const statuses = (api) => Object.fromEntries(h.allNodes(api).map((n) => [n.id, n.status]));

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const fileCount = api.store.getAllFiles().length;
    const first = statuses(api);
    t.check('the first run gave results', Object.keys(first).length > 0 && h.nodesWithStatus(api, 'pending').length === 0);

    {
      const rec = recordExplorer(api);
      try {
        await vscode.commands.executeCommand('liveTestRunner.clearCacheAndRestart');
      } finally { rec.restore(); }
      const inits = rec.sent.filter((m) => m.type === 'init');
      t.check('restart: the views were resynced to the cleared store', inits.some((m) => m.total === 0 && m.files.length === 0),
        JSON.stringify(inits.map((m) => m.total)));
      const cleared = rec.sent.findIndex((m) => m.type === 'init' && m.total === 0);
      t.check('restart: a new session started after the clear', rec.sent.slice(cleared + 1).some((m) => m.type === 'session-started'));
      t.check('restart: the session is active', api.session.isActive());
      t.eq('restart: every file is back', api.store.getAllFiles().length, fileCount);
      t.eq('restart: the same results as the first run', statuses(api), first);
      t.eq('restart: nothing left running or pending', [...h.nodesWithStatus(api, 'running'), ...h.nodesWithStatus(api, 'pending')].map((n) => n.id), []);
    }

    {
      const rec = recordExplorer(api);
      try {
        await vscode.commands.executeCommand('liveTestRunner.stopAndClearCache');
      } finally { rec.restore(); }
      t.check('stop and clear: the session stopped', !api.session.isActive());
      t.eq('stop and clear: the store is empty', api.store.getAllFiles().length, 0);
      t.check('stop and clear: the views were resynced', rec.sent.some((m) => m.type === 'init' && m.total === 0 && m.sessionActive === false));
    }
  },
};
