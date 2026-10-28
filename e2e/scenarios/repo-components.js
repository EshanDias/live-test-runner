'use strict';
/**
 * A real project with UI components (LTR_E2E_COMPONENT_REPO, via
 * e2e/real-repos.js — vue-testing-library and vue-multiselect (Vue + Jest),
 * the jest-preset-angular example app (Angular + Jest, templateUrl HTML),
 * svelte-testing-library (Svelte + Vitest)):
 *   - the full run matches a plain run of the project's runner test for test
 *     (LTR_E2E_COMPONENT_BASELINE, Jest or Vitest json);
 *   - component files (LTR_E2E_COMPONENT_EXTS, e.g. "vue" or "html") have
 *     covering tests and, where the framework measures them, coverage;
 *   - saving a component used by 1–3 test files reruns those test files only;
 *   - the saved file is restored byte for byte; nothing is left running.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, exts, out); } else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) { out.push(p); }
  }
  return out;
}

async function waitIdle(api, timeout = 300_000) {
  await h.sleep(1200);
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout });
  await h.sleep(300);
}

module.exports = {
  workspace: 'env:LTR_E2E_COMPONENT_REPO',
  timeoutMs: 25 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const exts = (process.env.LTR_E2E_COMPONENT_EXTS || 'vue,svelte').split(',');
    await h.waitForDiscovery(api);
    let since = h.isoNow();
    const started = Date.now();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await waitIdle(api, 20 * 60_000);
    t.info(`full run: ${((Date.now() - started) / 1000).toFixed(0)}s, summary ${JSON.stringify(api.store.getSummary())}`);
    let logs = h.logsSince(api, since);
    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);

    const baseline = process.env.LTR_E2E_COMPONENT_BASELINE;
    if (baseline && fs.existsSync(baseline)) {
      const json = JSON.parse(fs.readFileSync(baseline, 'utf8'));
      const want = h.jestJsonCounts({ ...json, testResults: json.testResults.filter((f) => f.assertionResults.length > 0 || !f.message) }, workspace);
      const diffs = [];
      for (const [file, c] of want) {
        const k = api.store.findFileKey(file);
        if (!k) { diffs.push(`${path.basename(file)}: not in the tree`); continue; }
        const got = { passed: 0, failed: 0, skipped: 0 };
        for (const n of api.store.getFileNodes(k)) {
          if (n.type !== 'test') { continue; }
          if (n.status in got) { got[n.status]++; }
        }
        if (got.passed !== c.passed || got.failed !== c.failed || got.skipped !== c.skipped) {
          diffs.push(`${path.relative(workspace, file)}: plain ${JSON.stringify(c)} vs extension ${JSON.stringify(got)}`);
        }
      }
      t.check(`results match the plain run for all ${want.size} files`, want.size > 0 && diffs.length === 0, diffs.slice(0, 15).join('\n'));
    }
    // (A file that fails in the plain run too may get the "could not be loaded" hint — that is not ours.)
    const warns = logs.filter((l) => /\[warn\]/.test(l) && /could not instrument|trace is off|transformer .* failed/.test(l));
    t.check('no instrumentation / trace warnings', warns.length === 0, warns.slice(0, 10).join('\n'));

    // ── Components: covering tests and coverage ──
    const components = walk(workspace, exts).filter((f) => !/[\\/](test|tests|__tests__|spec)[\\/]/.test(f) || true);
    const isTest = (f) => !!api.store.findFileKey(f);
    // Files next to a component that name it ('./x.component.html' — Angular's templateUrl) stand in for it.
    const referrers = (f) => {
      const name = path.basename(f);
      return fs.readdirSync(path.dirname(f)).map((e) => path.join(path.dirname(f), e))
        .filter((g) => g !== f && /\.[cm]?[jt]sx?$/.test(g) && !/\.(test|spec)\./.test(g) && [`'./${name}'`, `"./${name}"`].some((n) => fs.readFileSync(g, 'utf8').includes(n)));
    };
    const used = components.map((f) => {
      const k = key(f);
      const byTrace = api.traceStore.getAffectedTestFiles(k);
      const byGraph = api.traceStore.getDependentTestFiles(k, isTest);
      const byReferrer = byTrace.length || byGraph.length ? [] : referrers(f).flatMap((g) => api.traceStore.getAffectedTestFiles(key(g)));
      return { f, tests: [...new Set([...byTrace, ...byGraph, ...byReferrer].map((x) => path.basename(x)))], traced: byTrace.length > 0 };
    }).filter((x) => x.tests.length > 0);
    t.info(`${components.length} component file(s), ${used.length} used by tests (${used.filter((u) => u.traced).length} with traced lines)`);
    t.check('tests are mapped to component files', used.length > 0, components.slice(0, 10).join('\n'));
    const traced = used.filter((u) => u.traced);
    if (exts.some((e) => e !== 'html')) {
      t.check('component lines have covering tests', traced.length > 0, JSON.stringify(used.slice(0, 5)));
      const measured = traced.filter((u) => api.coverageStore.getEntry(key(u.f))?.state === 'measured');
      // LTR_E2E_COMPONENT_COVERAGE=0: the project's coverage settings leave its components out (collectCoverageFrom).
      if (process.env.LTR_E2E_COMPONENT_COVERAGE !== '0') t.check('components are measured for coverage', measured.length > 0, traced.slice(0, 5).map((u) => `${path.basename(u.f)}: ${api.coverageStore.getEntry(key(u.f))?.state}`).join('\n'));
    }

    // ── Saving a component reruns the test files that use it ──
    const pick = used.filter((u) => u.tests.length >= 1 && u.tests.length <= 3).sort((a, b) => a.tests.length - b.tests.length)[0];
    if (!pick) {
      t.check('found a component used by 1–3 test files', false, JSON.stringify(used.slice(0, 10)));
      return;
    }
    const original = fs.readFileSync(pick.f, 'utf8');
    try {
      const rec = h.recordEvents(api);
      since = h.isoNow();
      await h.editAndSave(vscode, pick.f, (s) => s + '\n<!-- ltr-e2e touch -->\n');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      const ran = [...new Set(rec.of('file-result').map((e) => e.file))].sort();
      rec.stop();
      t.check(`saving ${path.relative(workspace, pick.f)} reran its test file(s): ${pick.tests.join(', ')}`,
        ran.length > 0 && ran.every((f) => pick.tests.includes(f)), `ran: ${ran.join(', ')}\n${logs.filter((l) => /rerun|related/i.test(l)).join('\n')}`);
      t.eq('no test left running after the save', h.nodesWithStatus(api, 'running').length, 0);
    } finally {
      await h.editAndSave(vscode, pick.f, () => original);
      await waitIdle(api);
      t.check(`${path.basename(pick.f)} restored byte for byte`, fs.readFileSync(pick.f, 'utf8') === original);
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  },
};
