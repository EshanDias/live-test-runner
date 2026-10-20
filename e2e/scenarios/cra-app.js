'use strict';
/**
 * Create React App fixture (react-scripts 5 → its own Jest 27, jsdom, a
 * setupTests.js with hooks, --resetMocks in the test script): everything that
 * copy-requisition exercised, small enough for CI.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const h = require('../lib/harness');

async function waitIdle(api) {
  await h.sleep(800);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 300_000 });
  await h.sleep(500);
}

module.exports = {
  workspace: 'fixture:cra',
  timeoutMs: 15 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const rec = h.recordEvents(api);
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);

    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    t.eq('one run-finished', rec.of('run-finished').length, 1);
    const bad = logs.filter((l) => /returned no results|falling back to plain Jest|failed to run|could not instrument/.test(l));
    t.check('CRA: instrumented run worked (no fallback, no instrumentation error)', bad.length === 0, bad.join('\n'));
    t.eq('App.test.js: components, it.each table, nested ?.', h.statusCounts(api, 'src/App.test.js'), { passed: 4 });
    h.checkMatchesPlainJest(api, t, workspace);

    const fmt = h.fileBySuffix(api, 'src/format.test.js');
    const out = api.store.getFileOutput(fmt.fileId).lines.map((l) => l.text);
    t.check('console output captured', out.some((l) => l.includes('formatting money')), JSON.stringify(out));

    // Trace with project hooks in setupTests.js (BUG-28).
    const lower = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());
    const appSrc = lower(path.join(workspace, 'src', 'App.js'));
    const affected = api.traceStore.getAffectedTestFiles(appSrc);
    t.check('trace maps App.js → App.test.js only', affected.length === 1 && /App\.test\.js$/.test(affected[0]), JSON.stringify(affected));
    const cov = api.coverageStore.getEntry(appSrc);
    t.check('coverage measured for App.js', cov && cov.state === 'measured', JSON.stringify(cov));

    // Save a source file: only its test file reruns.
    {
      const mark = h.rawMark(api);
      await h.editAndSave(vscode, path.join(workspace, 'src', 'format.js'), (s) => s + '\n// touched\n');
      await waitIdle(api);
      const cmds = h.rawSince(api, mark).filter((l) => /^\[jest#\d+\] > /.test(l));
      t.check('saving format.js reruns only format.test.js', cmds.length === 1 && /format\.test\.js/.test(cmds[0]) && !/App\.test\.js/.test(cmds[0]),
        cmds.join('\n'));
      t.eq('format.test.js still passes', h.statusCounts(api, 'src/format.test.js'), { passed: 1 });
    }

    // ▶ Run one test.
    const test = h.nodeByName(api, 'src/App.test.js', 'counts clicks');
    {
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: test.fileId, nodeId: test.id, fullName: test.fullName });
      const sums = h.jestTestSummaries(h.rawSince(api, mark));
      t.check('▶ Run "counts clicks" ran exactly 1 test', sums.length === 1 && sums[0].passed === 1, JSON.stringify(sums));
    }

    // ▷ Debug: react-scripts' Jest + the extracted config, replayed with plain node.
    {
      const config = await api.session.debugFromEditor(test.fileId, test.fullName, false);
      t.check('CRA debug session started', !!config);
      if (config) {
        await h.waitFor(() => !vscode.debug.activeDebugSession, { what: 'debug session to end', timeout: 180_000 }).catch(() => {});
        const env = { ...process.env, ...config.env, CI: 'true' };
        delete env.ELECTRON_RUN_AS_NODE;
        const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [config.program, ...config.args],
          { cwd: config.cwd, encoding: 'utf8', env, timeout: 300_000 });
        const sums = h.jestTestSummaries(`${r.stdout}\n${r.stderr}`.split(/\r?\n/));
        t.check('CRA debug config runs exactly that test', sums.length === 1 && sums[0].passed === 1,
          JSON.stringify(sums) + (r.stderr || '').slice(-600));
      }
    }

    // Timeline.
    {
      const store = await api.instrumentedRunner.run({ filePath: test.fileId, testFullName: test.fullName, projectRoot: workspace });
      t.check('CRA timeline recorded steps', store.steps.length > 0, `steps: ${store.steps.length}`);
    }

    // Stop mid-run.
    {
      const p = vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => h.jestProcesses(workspace).length > 0, { what: 'Jest to start', timeout: 180_000 });
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      await h.sleep(4000);
      const left = h.jestProcesses(workspace);
      t.check('Stop leaves no Jest process', left.length === 0, left.join('\n'));
      await p;
      t.eq('Stop leaves nothing spinning', h.nodesWithStatus(api, 'running').length, 0);
    }
    rec.stop();
  },
};
