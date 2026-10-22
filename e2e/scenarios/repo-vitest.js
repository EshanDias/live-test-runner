'use strict';
/**
 * A real Vitest project (LTR_E2E_VITEST_REPO — unplugin, slidev, vueuse via
 * e2e/real-repos.js): the full run matches a plain `vitest run`
 * (LTR_E2E_VITEST_BASELINE) test for test, discovery finds the tests before
 * Start, coverage is measured when the provider package is installed (else
 * one "coverage is off" line), ▶ Run on one test works, a saved test file reruns, and Stop ends
 * every Vitest process. A saved file is restored to its exact content.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

/** True when the project can load a Vitest coverage provider package. */
function hasCoverageProvider(workspace) {
  return ['@vitest/coverage-v8', '@vitest/coverage-istanbul'].some((p) => {
    try { require.resolve(`${p}/package.json`, { paths: [workspace] }); return true; } catch { return false; }
  });
}

/** The first relative import of a test file that is an existing source file (not a test, not in node_modules). */
function relativeImport(testFile) {
  const code = fs.readFileSync(testFile, 'utf8');
  for (const m of code.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = path.resolve(path.dirname(testFile), m[1]);
    for (const f of [base, ...['.ts', '.js', '.mts', '.mjs', '.tsx'].map((e) => base + e), ...['index.ts', 'index.js'].map((i) => path.join(base, i))]) {
      if (fs.existsSync(f) && fs.statSync(f).isFile() && !/\.(test|spec)\./.test(f) && !/node_modules/.test(f)) { return f; }
    }
  }
  return undefined;
}

async function waitIdle(api) {
  await h.sleep(1200);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 15 * 60_000 });
  await h.sleep(300);
}

module.exports = {
  workspace: 'env:LTR_E2E_VITEST_REPO',
  timeoutMs: 25 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const discovered = h.allNodes(api).filter((n) => n.type === 'test').length;
    t.check(`static discovery found tests before Start (${discovered})`, discovered > 0);

    const hadCoverageDir = fs.existsSync(path.join(workspace, 'coverage'));
    const rec = h.recordEvents(api);
    const since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    t.info(`full run: ${((Date.now() - started) / 1000).toFixed(0)}s, summary ${JSON.stringify(api.store.getSummary())}`);
    const logs = h.logsSince(api, since);

    t.check('session uses Vitest', logs.some((l) => /framework: vitest/.test(l)), logs.filter((l) => /Session started/.test(l)).join('\n'));
    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    t.eq('one run-finished', rec.of('run-finished').length, 1);
    const fallback = logs.filter((l) => /falling back to plain|retrying it with plain/.test(l));
    t.check('no single-file fallback', fallback.length === 0, fallback.slice(0, 10).join('\n'));

    // Coverage: measured when the project has its provider package, else one "coverage is off" line and nothing measured.
    const measured = [...api.coverageStore.getAllEntries()].filter(([, e]) => e.state === 'measured');
    const off = logs.filter((l) => /Vitest coverage is off/.test(l));
    if (hasCoverageProvider(workspace)) {
      t.check(`coverage measured (${measured.length} files)`, measured.length > 0);
      t.eq('…no "coverage is off" line', off, []);
      const inProject = measured.filter(([f]) => !f.startsWith(workspace) && !f.startsWith(fs.realpathSync(workspace)));
      t.eq('…only project files measured', inProject.map(([f]) => f).slice(0, 5), []);
    } else {
      t.check('no coverage provider: says so once', off.length === 1, off.join('\n'));
      t.eq('…and nothing measured', measured.length, 0);
    }
    t.check('no coverage/ folder written into the project', hadCoverageDir || !fs.existsSync(path.join(workspace, 'coverage')));

    const baseline = process.env.LTR_E2E_VITEST_BASELINE;
    if (baseline && fs.existsSync(baseline)) {
      h.checkMatchesPlainVitest(api, t, workspace, 'results match plain Vitest', JSON.parse(fs.readFileSync(baseline, 'utf8')));
    } else {
      t.info('no plain Vitest baseline — comparison skipped');
    }

    // ▶ Run on one passing test.
    const one = h.allNodes(api).find((n) => n.type === 'test' && n.status === 'passed');
    if (one) {
      const before = Object.fromEntries(h.allNodes(api).filter((n) => n.fileId === one.fileId).map((n) => [n.id, n.status]));
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: one.fileId, nodeId: one.id, fullName: one.fullName });
      const cmds = h.rawSince(api, mark).filter((l) => /^\[vitest#\d+\] > /.test(l));
      t.check(`▶ Run "${one.fullName}" used a -t pattern`, cmds.some((l) => / -t /.test(l)), cmds.join('\n'));
      t.eq('…and it still passes', api.store.getNode(one.id).status, 'passed');
      const after = h.allNodes(api).filter((n) => n.fileId === one.fileId);
      const changed = after.filter((n) => before[n.id] !== undefined && before[n.id] !== n.status).map((n) => n.id);
      t.eq('…its siblings keep their results', changed, []);

      // Save that test file: it reruns. Restore the exact content afterwards.
      const original = fs.readFileSync(one.fileId, 'utf8');
      try {
        const mark2 = h.rawMark(api);
        await h.editAndSave(vscode, one.fileId, (s) => s + '\n');
        await waitIdle(api);
        const cmds2 = h.rawSince(api, mark2).filter((l) => /^\[vitest#\d+\] > /.test(l));
        t.check(`saving ${path.basename(one.fileId)} reruns it`, cmds2.some((l) => l.includes(path.basename(one.fileId))), cmds2.join('\n'));
      } finally {
        fs.writeFileSync(one.fileId, original);
      }
    }

    // Save a source file a passing test file imports: `vitest related` reruns it live (phase 6). Restored afterwards.
    const testFile = h.allNodes(api).find((n) => n.type === 'test' && n.status === 'passed')?.fileId;
    const src = testFile && relativeImport(testFile);
    if (src) {
      const original = fs.readFileSync(src, 'utf8');
      const rec2 = h.recordEvents(api);
      try {
        const mark3 = h.rawMark(api);
        const since3 = h.isoNow();
        await h.editAndSave(vscode, src, (s) => s + '\n');
        await waitIdle(api);
        const cmds3 = h.rawSince(api, mark3).filter((l) => /^\[vitest#\d+\] > /.test(l));
        const logs3 = h.logsSince(api, since3);
        const rel = path.relative(workspace, src);
        t.check(`saving ${rel} runs \`vitest related\``, cmds3.some((l) => / related /.test(l) && l.includes(path.basename(src))), cmds3.join('\n'));
        t.check(`…and reruns ${path.basename(testFile)}`, rec2.of('file-result').some((e) => e.file === path.basename(testFile)), JSON.stringify(rec2.of('file-result').slice(0, 10)));
        t.check('…without a plain-run fallback', !logs3.some((l) => /falling back to plain|retrying it with plain/.test(l)), logs3.join('\n'));
        t.eq('…nothing left running', h.nodesWithStatus(api, 'running').length, 0);
      } finally {
        rec2.stop();
        fs.writeFileSync(src, original);
      }
    } else {
      t.info('no relative source import found in a passing test file — source-save check skipped');
    }

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    await h.sleep(4000);
    const left = h.vitestProcesses(workspace);
    t.check('no Vitest process left after Stop', left.length === 0, left.join('\n'));
    rec.stop();
  },
};
