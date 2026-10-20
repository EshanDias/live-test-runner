'use strict';
/**
 * A real Create React App project (LTR_E2E_CRA_REPO). Never modifies files.
 *
 * Quick mode (default): a few files through ▶ Run, compared with plain
 * `react-scripts test` on the same files; ▶ Run of one test; Debug, Timeline,
 * coverage, trace, Stop.
 *
 * Full mode (LTR_E2E_CRA_FULL=1): Start Testing on the whole project; with
 * LTR_E2E_CRA_BASELINE (a `react-scripts test --json` result) every file is
 * compared with plain Jest.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../lib/harness');

const FULL = process.env.LTR_E2E_CRA_FULL === '1';

function storeCounts(api, fileId) {
  const c = { passed: 0, failed: 0, skipped: 0, other: 0 };
  for (const n of api.store.getFileNodes(fileId)) {
    if (n.type !== 'test') { continue; }
    if (n.status in c) { c[n.status]++; } else { c.other++; }
  }
  return c;
}

function compare(api, t, want, label) {
  const diffs = [];
  for (const [file, c] of want) {
    const key = api.store.findFileKey(file);
    if (!key) { diffs.push(`${path.basename(file)}: not in the tree`); continue; }
    const got = storeCounts(api, key);
    if (got.passed !== c.passed || got.failed !== c.failed || got.skipped !== c.skipped || got.other) {
      diffs.push(`${path.relative(api.store.getAllFiles()[0] ? '' : '', file)}: jest ${JSON.stringify(c)} vs extension ${JSON.stringify(got)}`);
    }
  }
  t.check(`${label}: results match plain Jest for ${want.size} file(s)`, diffs.length === 0, diffs.slice(0, 20).join('\n'));
}

/** Plain `react-scripts test` on some files, the way `npm test` runs them. */
function plainJest(workspace, files) {
  const out = path.join(os.tmpdir(), `ltr-e2e-cra-${Date.now()}.json`);
  const env = { ...process.env, CI: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [
    path.join(workspace, 'node_modules', 'react-scripts', 'bin', 'react-scripts.js'),
    'test', '--resetMocks', '--watchAll=false', '--json', `--outputFile=${out}`, '--runTestsByPath',
    // Jest matches paths case-sensitively against its realpath'd rootDir (C:\…).
    ...files.map((f) => f.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)),
  ], { cwd: workspace, env, encoding: 'utf8', timeout: 20 * 60_000 });
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  return json;
}

module.exports = {
  workspace: 'env:LTR_E2E_CRA_REPO',
  // A full run of a big CRA app takes hours: only cpus/4 instrumented Jest
  // processes run at once, by design (copy-requisition: ~32 min in plain Jest
  // with 11 workers).
  timeoutMs: FULL ? 180 * 60_000 : 25 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const files = api.store.getAllFiles().filter((f) => f.rootNodeIds.length > 0);
    t.info(`discovered ${files.length} test file(s), ${api.store.getSummary().total} test(s)`);

    if (FULL) {
      const rec = h.recordEvents(api);
      const since = h.isoNow();
      const started = Date.now();
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      t.info(`full run: ${((Date.now() - started) / 60000).toFixed(1)} min, summary ${JSON.stringify(api.store.getSummary())}`);
      const logs = h.logsSince(api, since);
      t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
      t.eq('one run-finished', rec.of('run-finished').length, 1);
      t.check('progress never exceeded 100%', rec.of('run-progress').every((p) => p.completed <= p.total));
      const fallback = logs.filter((l) => /returned no results|falling back to plain Jest|retrying it with plain Jest/.test(l));
      t.check('no fallback to plain Jest', fallback.length === 0, fallback.slice(0, 10).join('\n'));
      const hung = logs.filter((l) => /without finishing/.test(l));
      t.check('no file was stopped as hung', hung.length === 0, hung.join('\n'));
      const baseline = process.env.LTR_E2E_CRA_BASELINE;
      if (baseline && fs.existsSync(baseline)) {
        compare(api, t, h.jestJsonCounts(JSON.parse(fs.readFileSync(baseline, 'utf8')), workspace), 'full run');
      }
      const measured = [...api.coverageStore.getAllEntries()].filter(([, e]) => e.state === 'measured');
      t.check('coverage measured', measured.length > 10, `${measured.length} measured`);
      rec.stop();
      return;
    }

    // ── Quick mode ───────────────────────────────────────────────────────────
    // The smallest files: some files in big CRA apps take minutes even in plain Jest.
    const sample = files
      .map((f) => ({ id: f.fileId, size: fs.statSync(f.fileId).size }))
      .sort((a, b) => a.size - b.size)
      .slice(0, 4)
      .map((f) => f.id);
    t.info(`sample: ${sample.map((f) => path.relative(workspace, f)).join(', ')}`);
    const since = h.isoNow();
    for (const fileId of sample) {
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'file', fileId });
    }
    const logs = h.logsSince(api, since);
    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    const fallback = logs.filter((l) => /returned no results|falling back to plain Jest|retrying it with plain Jest/.test(l));
    t.check('CRA: instrumented runs worked (no fallback)', fallback.length === 0, fallback.slice(0, 10).join('\n'));
    compare(api, t, h.jestJsonCounts(plainJest(workspace, sample), workspace), 'sample');

    const mapped = api.traceStore.dump().split('\n').filter((l) => l.startsWith('  [source]'));
    t.check('BUG-04 trace maps source files to tests (CRA)', mapped.length > 0, `${mapped.length} mapped`);
    const measured = [...api.coverageStore.getAllEntries()].filter(([, e]) => e.state === 'measured');
    t.check('coverage measured (CRA)', measured.length > 0, `${measured.length} measured`);

    // ▶ Run one test.
    const test = h.allNodes(api).find((n) => n.type === 'test' && n.status === 'passed' && sample.includes(n.fileId) && !/[%$]/.test(n.fullName));
    if (test) {
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: test.fileId, nodeId: test.id, fullName: test.fullName });
      const sums = h.jestTestSummaries(h.rawSince(api, mark));
      t.check(`▶ Run "${test.fullName.slice(0, 60)}" ran exactly 1 test`, sums.length === 1 && sums[0].passed === 1, JSON.stringify(sums));

      // ▷ Debug config for CRA (react-scripts' Jest + extracted config).
      const config = await api.session.debugFromEditor(test.fileId, test.fullName, false);
      if (config) {
        t.info(`debug program: ${config.program}`);
        await h.waitFor(() => !vscode.debug.activeDebugSession, { what: 'debug session to end', timeout: 300_000 }).catch(() => {});
        const env = { ...process.env, ...config.env, CI: 'true' }; delete env.ELECTRON_RUN_AS_NODE;
        const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args], { cwd: config.cwd, encoding: 'utf8', env, timeout: 300_000 });
        const s2 = h.jestTestSummaries(`${r.stdout}\n${r.stderr}`.split(/\r?\n/));
        t.check('BUG-06 CRA debug config runs exactly that test', s2.length === 1 && s2[0].passed === 1, JSON.stringify(s2) + (r.stderr || '').slice(-600));
      } else {
        t.check('BUG-06 CRA debug session started', false);
      }

      // Timeline on CRA.
      const store = await api.instrumentedRunner.run({ filePath: test.fileId, testFullName: test.fullName, projectRoot: workspace });
      t.check('BUG-12 CRA timeline recorded steps', store.steps.length > 0, `steps: ${store.steps.length}`);
    } else {
      t.check('found a passing test to rerun', false);
    }

    // Stop mid-run.
    const p = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => h.jestProcesses(workspace).length > 0, { what: 'Jest to start', timeout: 180_000 });
    await h.sleep(15_000);
    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await h.sleep(5000);
    const left = h.jestProcesses(workspace);
    t.check('BUG-08 Stop leaves no Jest process (CRA)', left.length === 0, left.join('\n'));
    await p;
    t.eq('BUG-23 Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').length, 0);
  },
};
