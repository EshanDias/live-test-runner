'use strict';
/**
 * Diagnostic (not part of --all runs that lack the repo): reruns one file of
 * LTR_E2E_TSJEST_REPO and reports how many test results arrived vs how many
 * test nodes survive in the store, plus the first few lost names.
 * LTR_E2E_DIAG_FILE selects the file (path suffix).
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'env:LTR_E2E_TSJEST_REPO',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode }) {
    await h.waitForDiscovery(api);
    const suffix = process.env.LTR_E2E_DIAG_FILE || 'tests/output-manager.test.ts';
    const file = h.fileBySuffix(api, suffix);
    const nodesBefore = api.store.getFileNodes(file.fileId);
    t.info(`discovered nodes: ${nodesBefore.length} (${nodesBefore.filter((n) => n.type === 'test').length} tests, ` +
      `${nodesBefore.filter((n) => n.isDynamicTemplate).length} templates)`);
    for (const n of nodesBefore.filter((x) => x.isDynamicTemplate).slice(0, 8)) { t.info(`  template: ${n.type} "${n.name}"`); }

    const adapter = api.session._adapter;
    const orig = adapter.applyFileResult.bind(adapter);
    let received = [];
    adapter.applyFileResult = (store, fp, fr, opts) => {
      if (fp === file.fileId) { received = fr.testCases.map((tc) => tc.fullName); }
      return orig(store, fp, fr, opts);
    };

    const count = () => {
      const c = {};
      for (const n of api.store.getFileNodes(file.fileId)) { const k = `${n.type}:${n.status}`; c[k] = (c[k] || 0) + 1; }
      return JSON.stringify(c);
    };
    const origCleanup = api.store.cleanupStaleNodes.bind(api.store);
    api.store.cleanupStaleNodes = (fid, had, scope) => {
      if (fid === file.fileId) { t.info(`cleanup(had=${had}, scope=${scope}) before: ${count()}`); }
      const r = origCleanup(fid, had, scope);
      if (fid === file.fileId) { t.info(`cleanup after: ${count()}`); }
      return r;
    };
    const origRemove = api.store._removeNode.bind(api.store);
    let removedTests = 0;
    let firstRemoved;
    api.store._removeNode = (id) => {
      const n = api.store.getNode(id);
      if (n && n.fileId === file.fileId) {
        if (!firstRemoved) { firstRemoved = `${n.type}:${n.status}:"${n.fullName}" children=${n.children.length}`; }
        if (n.type === 'test' && n.status !== 'running') { removedTests++; }
      }
      return origRemove(id);
    };

    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId: file.fileId });
    t.info(`first removed node: ${firstRemoved}; finished tests removed: ${removedTests}`);
    const after = api.store.getFileNodes(file.fileId).filter((n) => n.type === 'test');
    const have = new Set(after.map((n) => n.fullName));
    const lost = received.filter((n) => !have.has(n));
    t.info(`results received: ${received.length}, test nodes after: ${after.length}, lost: ${lost.length}`);
    const seen = new Map();
    for (const n of received) { seen.set(n, (seen.get(n) || 0) + 1); }
    const dups = [...seen].filter(([, c]) => c > 1);
    t.info(`duplicate full names in Jest's results: ${dups.length}`);
    for (const [n, c] of dups.slice(0, 5)) { t.info(`  x${c} "${n}"`); }
    for (const n of lost.slice(0, 10)) { t.info(`  lost: "${n}"`); }
    for (const n of after.slice(0, 5)) { t.info(`  kept: "${n.fullName}" (${n.status})`); }
    t.check('no results lost', lost.length === 0);
  },
};
