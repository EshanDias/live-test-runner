'use strict';
/**
 * A real ts-jest project (LTR_E2E_TSJEST_REPO, e.g. vscode-jest): the full
 * run must match plain Jest test-for-test (LTR_E2E_TSJEST_BASELINE = output
 * of `jest --json`), and every feature must work on it. A saved source file
 * is restored to its exact original content.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

function storeCounts(api, fileId) {
  const c = { passed: 0, failed: 0, skipped: 0, other: 0 };
  for (const n of api.store.getFileNodes(fileId)) {
    if (n.type !== 'test') { continue; }
    if (n.status in c) { c[n.status]++; } else { c.other++; }
  }
  return c;
}

module.exports = {
  workspace: 'env:LTR_E2E_TSJEST_REPO',
  timeoutMs: 25 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    t.info(`full run: ${((Date.now() - started) / 1000).toFixed(0)}s, summary ${JSON.stringify(api.store.getSummary())}`);
    const logs = h.logsSince(api, since);

    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    t.eq('one run-finished', rec.of('run-finished').length, 1);
    const fallback = logs.filter((l) => /returned no results|falling back to plain Jest|retrying it with plain Jest/.test(l));
    t.check('BUG-07 no fallback to plain Jest', fallback.length === 0, fallback.slice(0, 10).join('\n'));

    // Test-for-test comparison with plain Jest.
    const baseline = process.env.LTR_E2E_TSJEST_BASELINE;
    if (baseline && fs.existsSync(baseline)) {
      const want = h.jestJsonCounts(JSON.parse(fs.readFileSync(baseline, 'utf8')), workspace);
      const diffs = [];
      for (const [file, c] of want) {
        const key = api.store.findFileKey(file);
        if (!key) { diffs.push(`${path.basename(file)}: not in the tree`); continue; }
        const got = storeCounts(api, key);
        if (got.passed !== c.passed || got.failed !== c.failed || got.skipped !== c.skipped) {
          diffs.push(`${path.basename(file)}: jest ${JSON.stringify(c)} vs extension ${JSON.stringify(got)}`);
        }
      }
      t.check(`results match plain Jest for all ${want.size} files`, diffs.length === 0, diffs.slice(0, 15).join('\n'));
    }

    // Trace + coverage.
    const srcRoot = path.join(workspace, 'src').toLowerCase();
    const mapped = api.traceStore.dump().split('\n').filter((l) => l.startsWith('  [source]')).map((l) => l.slice(11).trim());
    t.check('BUG-04 trace maps source files to tests', mapped.length > 5, `${mapped.length} source file(s) mapped`);
    const measured = [...api.coverageStore.getAllEntries()].filter(([, e]) => e.state === 'measured');
    t.check('coverage measured for source files', measured.length > 5, `${measured.length} measured`);
    const dropped = logs.filter((l) => /coverage dropped/.test(l));
    t.check('no coverage dropped (cached transforms keep their manifests)', dropped.length === 0, dropped.join('\n'));

    // ▶ Run a single test. Jest runs it once per project that includes its
    // file (e.g. jest-dom: jsdom + node), so expect that many passes.
    const testNode = h.allNodes(api).find((n) => n.type === 'test' && n.status === 'passed' && / /.test(n.fullName) && !n.fullName.includes('%'));
    const runsPerFile = baseline && fs.existsSync(baseline)
      ? h.jestJsonRunsPerFile(JSON.parse(fs.readFileSync(baseline, 'utf8')), workspace)
      : new Map();
    const runs = runsPerFile.get(testNode.fileId) ?? 1;
    {
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', {
        scope: 'test', fileId: testNode.fileId, nodeId: testNode.id, fullName: testNode.fullName,
      });
      const sums = h.jestTestSummaries(h.rawSince(api, mark));
      t.check(`BUG-03 ▶ Run "${testNode.fullName.slice(0, 60)}" ran only that test (${runs} Jest project(s))`, sums.length === 1 && sums[0].passed === runs, JSON.stringify(sums));
      t.eq('the test still passes', api.store.getNode(testNode.id).status, 'passed');
    }

    // Save a source file that only some tests use → trace-based rerun, then restore it.
    const candidates = mapped
      .filter((f) => f.toLowerCase().startsWith(srcRoot) && /\.[jt]sx?$/.test(f))
      .map((f) => ({ f, n: api.traceStore.getAffectedTestFiles(f).length }))
      .filter((x) => x.n >= 1 && x.n <= 3)
      .sort((a, b) => a.n - b.n);
    if (candidates.length) {
      const src = candidates[0].f;
      const original = fs.readFileSync(src, 'utf8');
      try {
        const s2 = h.isoNow();
        const mark = h.rawMark(api);
        await h.editAndSave(vscode, src, (s) => s + '\n// ltr-e2e touch\n');
        await h.sleep(800);
        await h.waitFor(() => api.session._activeRuns === 0, { what: 'save rerun', timeout: 300_000 });
        const l2 = h.logsSince(api, s2);
        t.check(`BUG-04 saving ${path.basename(src)} used the trace`, l2.some((l) => /Trace-based rerun/.test(l)), l2.join('\n'));
        const cmds = h.rawSince(api, mark).filter((l) => /^\[jest#\d+\] > /.test(l));
        t.check(`save reran ${candidates[0].n} file(s) or fewer`, cmds.length >= 1 && cmds.length <= candidates[0].n, cmds.join('\n'));
        t.eq('no test left running after the save rerun', h.nodesWithStatus(api, 'running').length, 0);
      } finally {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(src));
        await h.editAndSave(vscode, src, () => original);
        await doc.save();
        await h.sleep(800);
        await h.waitFor(() => api.session._activeRuns === 0, { what: 'restore rerun', timeout: 300_000 });
        t.check(`${path.basename(src)} restored byte-for-byte`, fs.readFileSync(src, 'utf8') === original);
      }
    } else {
      t.check('found a source file used by 1–3 test files', false, mapped.slice(0, 10).join('\n'));
    }

    // ▷ Debug config runs only that test (replayed with plain node).
    {
      const config = await api.session.debugFromEditor(testNode.fileId, testNode.fullName, false);
      if (config) {
        await h.waitFor(() => !vscode.debug.activeDebugSession, { what: 'debug session to end', timeout: 120_000 }).catch(() => {});
        const env = { ...process.env, ...config.env }; delete env.ELECTRON_RUN_AS_NODE;
        const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args], { cwd: config.cwd, encoding: 'utf8', env, timeout: 300_000 });
        const sums = h.jestTestSummaries(`${r.stdout}\n${r.stderr}`.split(/\r?\n/));
        t.check(`BUG-06 debug config runs only that test (${runs} Jest project(s))`, sums.length === 1 && sums[0].passed === runs, JSON.stringify(sums) + (r.stderr || '').slice(-400));
      } else {
        t.check('BUG-06 debug session started', false);
      }
    }

    // Timeline.
    {
      const store = await api.instrumentedRunner.run({ filePath: testNode.fileId, testFullName: testNode.fullName, projectRoot: workspace });
      t.check('BUG-12 timeline recorded steps', store.steps.length > 0, `steps: ${store.steps.length}`);
    }

    // Stop mid-run.
    {
      const p = vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => h.jestProcesses(workspace).length > 0, { what: 'Jest to start', timeout: 120_000 });
      await h.sleep(5000);
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      await h.sleep(4000);
      const left = h.jestProcesses(workspace);
      t.check('BUG-08 Stop leaves no Jest process', left.length === 0, left.join('\n'));
      await p;
      t.eq('BUG-23 Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').length, 0);
    }
    rec.stop();
  },
};
