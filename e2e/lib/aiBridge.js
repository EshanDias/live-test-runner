'use strict';
/**
 * The AI-assistant bridge end to end, for one framework: a real VS Code, the
 * real framework, and an agent's view of it — the MCP relay started through
 * the launcher, driven by a scripted client. The agent finds the failure,
 * explains it, "fixes" the source on disk, verifies the fix and reruns a test;
 * VS Code's own language-model tool API answers the same; failures reach the
 * Problems list with a Fix with AI quick fix.
 */
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { startMcp } = require('./mcpClient');

/**
 * @param cfg.source      [rel, buggy content, fixed content]
 * @param cfg.test        [rel, content]
 * @param cfg.failing     full name of the test that fails until the fix
 * @param cfg.trace       the framework has the per-test trace (lines run, affected tests)
 */
async function aiBridgeScenario({ api, t, vscode, workspace }, cfg) {
  const [srcRel, buggy, fixed] = cfg.source;
  const [testRel, testText] = cfg.test;
  const srcFile = path.join(workspace, ...srcRel.split('/'));
  const testFile = path.join(workspace, ...testRel.split('/'));
  fs.writeFileSync(srcFile, buggy);
  fs.writeFileSync(testFile, testText);

  await h.waitForDiscovery(api);
  await vscode.commands.executeCommand('liveTestRunner.startTesting');
  await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 240_000 });
  const node = h.nodeByName(api, testRel, cfg.failing);
  t.eq('the test fails before the fix', node.status, 'failed');

  // ── The window announces itself ─────────────────────────────────────────
  const bridge = api.aiBridge;
  t.check('bridge.json in the session folder', fs.existsSync(path.join(api.sessionDir, 'bridge.json')));
  t.check('the launcher is in the extension\'s storage folder', fs.existsSync(bridge.launcherPath), bridge.launcherPath);

  // ── Problems list + Fix with AI ─────────────────────────────────────────
  api.failureDiagnostics.refresh();
  const diags = vscode.languages.getDiagnostics(vscode.Uri.file(testFile)).filter((d) => d.source === 'Live Test Runner');
  const all = vscode.languages.getDiagnostics().flatMap(([u, ds]) => ds.filter((d) => d.source === 'Live Test Runner').map((d) => `${u.fsPath}:${d.range.start.line + 1} ${d.message}`));
  t.check('the failure is in the Problems list, on the test file', diags.some((d) => d.message.startsWith(cfg.failing)), JSON.stringify({ testFile, all }));
  if (diags[0]) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
    await vscode.window.showTextDocument(doc);
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(diags[0].range.start.line, 0, diags[0].range.start.line, 0));
    t.check('…with a Fix with AI quick fix', (actions ?? []).some((a) => a.title === 'Fix with AI (Live Test Runner)'), JSON.stringify((actions ?? []).map((a) => a.title)));
  }
  const how = await vscode.commands.executeCommand('liveTestRunner.fixWithAI', node.fileId, node.id);
  if (how === 'clipboard') {
    const clip = await vscode.env.clipboard.readText();
    t.check('Fix with AI without a chat: the failure is copied', clip.includes(cfg.failing) && clip.includes('Explain why'), clip.slice(0, 200));
  } else {
    t.eq('Fix with AI opened the chat', how, 'chat');
  }

  // ── An agent connects ───────────────────────────────────────────────────
  const mcp = startMcp(bridge.launcherPath, workspace);
  try {
    const init = await mcp.initialize();
    t.check('initialize: the server and its instructions', init?.serverInfo?.name === 'live-test-runner' && /LTR_get_failures/.test(init.instructions ?? ''), JSON.stringify(init).slice(0, 300));
    const list = await mcp.request('tools/list');
    t.check('tools/list: the LTR_ tools', (list.result?.tools ?? []).length >= 20, JSON.stringify(list).slice(0, 200));

    const status = await mcp.call('LTR_get_status');
    t.check('get_status: session on, the failure counted', status.projects?.[0]?.session === 'on' && status.projects[0].tests.failed >= 1, JSON.stringify(status));
    t.check('get_status: says which window answered', (status.window?.folders ?? []).length > 0, JSON.stringify(status.window));

    const failures = await mcp.call('LTR_get_failures');
    const f = (failures.failures ?? []).find((x) => x.name === cfg.failing);
    t.check('get_failures: the failing test with an id', !!f?.id, JSON.stringify(failures));
    if (!f) { return; }

    const ex = await mcp.call('LTR_explain_failure', { id: f.id });
    t.check('explain_failure: the error', !!ex.error?.summary, JSON.stringify(ex.error));
    t.check('explain_failure: the source line it was thrown from', ex.thrownAt?.file === srcRel || (ex.error?.stack ?? []).some((s) => s.startsWith(srcRel)), JSON.stringify({ thrownAt: ex.thrownAt, stack: ex.error?.stack }));
    t.check('explain_failure: the test\'s code', typeof ex.testCode?.code === 'string' && ex.testCode.code.length > 0, JSON.stringify(ex.testCode));
    t.check('explain_failure: no machine paths', !JSON.stringify(ex).includes(workspace), '');
    if (cfg.trace) {
      t.check('explain_failure: the source lines the test ran (trace)', Array.isArray(ex.linesRun) && ex.linesRun.some((l) => l.file === srcRel), JSON.stringify(ex.linesRun));
      const affected = await mcp.call('LTR_get_affected_tests', { file: srcRel });
      t.check('get_affected_tests: the traced test', (affected.tests ?? []).some((x) => x.name === cfg.failing), JSON.stringify(affected));
    }
    const found = await mcp.call('LTR_find_tests', { query: cfg.failing });
    t.eq('find_tests: the same id', found.matches?.[0]?.id, f.id);
    const cov = await mcp.call('LTR_get_coverage', { file: srcRel });
    t.check('get_coverage: the source file is measured', !!cov.percent || /not run/.test(cov.coverage ?? ''), JSON.stringify(cov));

    // ── The agent fixes the code on disk and verifies ─────────────────────
    fs.writeFileSync(srcFile, fixed);
    const verify = await mcp.finish(await mcp.call('LTR_verify_fix', { files: [srcRel] }));
    t.eq('verify_fix: finished', verify.state, 'finished');
    t.check('verify_fix: reports the test fixed', (verify.fixed ?? []).some((x) => x.name === cfg.failing) || api.store.getNode(node.id)?.status === 'passed', JSON.stringify(verify));
    t.eq('verify_fix: no regressions', (verify.newlyFailing ?? []).map((x) => x.name), []);
    t.eq('the store agrees: the test passes', api.store.getNode(node.id)?.status, 'passed');

    const run = await mcp.finish(await mcp.call('LTR_run_tests', { ids: [f.id] }));
    t.check('run_tests: ran like ▶ Run, one test passed', run.state === 'finished' && run.tests?.passed === 1 && run.tests?.failed === 0, JSON.stringify(run));
    const out = await mcp.call('LTR_get_output', { id: f.id });
    t.check('get_output: an answer for the scope (output or why none)', typeof out.captured === 'boolean', JSON.stringify(out));

    // ── Runs off: reads only ──────────────────────────────────────────────
    const cfgSection = vscode.workspace.getConfiguration('liveTestRunner');
    await cfgSection.update('ai.allowRuns', 'never', vscode.ConfigurationTarget.Workspace);
    try {
      const r2 = await mcp.call('LTR_run_tests', { ids: [f.id] });
      t.check('allowRuns never: runs refused', r2.isError && /allowRuns/.test(r2.error ?? ''), JSON.stringify(r2));
      const read = await mcp.call('LTR_get_failures');
      t.check('…reads still answer', !read.isError && typeof read.failing === 'number', JSON.stringify(read));
    } finally {
      await cfgSection.update('ai.allowRuns', undefined, vscode.ConfigurationTarget.Workspace);
    }
  } finally {
    mcp.close();
  }

  // ── Copilot's way in: VS Code's language-model tools ────────────────────
  const lm = vscode.lm;
  if (lm && typeof lm.invokeTool === 'function') {
    const names = (lm.tools ?? []).map((x) => x.name);
    t.check('VS Code lists the LTR_ tools', names.includes('LTR_get_status') && names.includes('LTR_verify_fix'), JSON.stringify(names.filter((n) => n.startsWith('LTR_'))));
    const res = await lm.invokeTool('LTR_get_failures', { input: {}, toolInvocationToken: undefined });
    const text = (res?.content ?? []).map((p) => p.value ?? '').join('');
    t.check('invokeTool answers from the same stores', /"failing":\d+/.test(text) && !text.includes(cfg.failing), text.slice(0, 300));
  } else {
    t.info(`VS Code ${vscode.version} has no vscode.lm.invokeTool — language-model tools not checked`);
  }

  await vscode.commands.executeCommand('liveTestRunner.stopTesting');
}

module.exports = { aiBridgeScenario };
