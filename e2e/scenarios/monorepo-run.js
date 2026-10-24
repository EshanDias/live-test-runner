'use strict';
/**
 * Two projects running at once (phase 7, D11/D12): start both, switch the
 * views back and forth while they run, results land in each project's own
 * store; a background project reruns on save; a package whose Vitest config
 * has test.projects is one project whose files are grouped by project name.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const norm = (p) => p.replace(/\\/g, '/');
const SLOW = "import { test, expect } from 'vitest';\ntest('takes a few seconds', async () => { await new Promise((r) => setTimeout(r, 4000)); expect(1).toBe(1); });\n";

module.exports = {
  workspace: 'fixture:monorepo-vitest',
  settings: { 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    // Slow files keep both runs in flight long enough to switch between them.
    fs.writeFileSync(path.join(workspace, 'packages', 'lib', 'src', 'slow.test.js'), SLOW);
    fs.writeFileSync(path.join(workspace, 'packages', 'web', 'src', 'slow.test.js'), SLOW);

    const reg = api.projects;
    t.eq('two Vitest projects (lib with test.projects is one entry, D12)', reg.contexts.map((c) => [c.name, c.framework]), [['lib', 'vitest'], ['web', 'vitest']]);
    const [lib, web] = reg.contexts;
    const rel = (ctx) => ctx.store.getAllFiles().map((f) => norm(path.relative(workspace, f.filePath))).sort();

    await h.waitForDiscovery(api);
    await h.waitFor(() => lib.store.getAllFiles().length === 3, { what: 'lib discovery', timeout: 30_000 });

    // ── Start lib, switch to web, start it too ─────────────────────────────
    const libStart = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => lib.session.isRunning(), { what: 'lib to start running', timeout: 30_000 });
    await vscode.commands.executeCommand('liveTestRunner.selectProject', web.id);
    await h.waitForDiscovery(api);
    const webStart = vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => web.session.isRunning(), { what: 'web to start running', timeout: 30_000 });
    t.eq('both projects run at once', reg.running().map((c) => c.name), ['lib', 'web']);
    t.check('status bar: selected project and "2 running"', /^Live Tests: web · .* · 2 running$/.test(api.statusBar.text), api.statusBar.text);

    // Switch while both run: the views follow, progress keeps coming.
    let switches = 0;
    while ((lib.session.isRunning() || web.session.isRunning()) && switches < 6) {
      const target = switches % 2 === 0 ? lib : web;
      await vscode.commands.executeCommand('liveTestRunner.selectProject', target.id);
      t.check(`switch ${switches + 1}: the views show ${target.name}`, api.store === target.store && reg.selected === target);
      switches++;
      await h.sleep(700);
    }
    t.check('switched at least twice while running', switches >= 2, `switches: ${switches}`);
    await Promise.all([libStart, webStart]);
    await h.waitFor(() => !lib.session.isRunning() && !web.session.isRunning(), { what: 'both runs to finish', timeout: 120_000 });

    // ── Results per project ────────────────────────────────────────────────
    t.eq('lib\'s store has lib\'s files only', rel(lib), ['packages/lib/src/math.test.js', 'packages/lib/src/slow.test.js', 'packages/lib/test/flow.test.js']);
    t.eq('web\'s store has web\'s files only', rel(web), ['packages/web/src/format.test.js', 'packages/web/src/slow.test.js']);
    const counts = (ctx) => { const s = ctx.store.getSummary(); return { total: s.total, passed: s.passed, failed: s.failed }; };
    t.eq('lib results', counts(lib), { total: 5, passed: 4, failed: 1 });
    t.eq('web results', counts(web), { total: 3, passed: 3, failed: 0 });
    await vscode.commands.executeCommand('liveTestRunner.selectProject', lib.id);
    h.checkMatchesPlainVitest(api, t, path.join(workspace, 'packages', 'lib'), 'lib matches plain Vitest');
    await vscode.commands.executeCommand('liveTestRunner.selectProject', web.id);
    h.checkMatchesPlainVitest(api, t, path.join(workspace, 'packages', 'web'), 'web matches plain Vitest');

    // ── D12: lib's files are grouped by Vitest project name ────────────────
    const groups = Object.fromEntries(lib.store.getAllFiles().map((f) => [path.basename(f.filePath), f.group]));
    t.eq('lib files grouped by Vitest project', groups, { 'math.test.js': 'unit', 'slow.test.js': 'unit', 'flow.test.js': 'integration' });
    t.check('web (one project) has no groups', web.store.getAllFiles().every((f) => !f.group));
    t.check('groups reach the webview data', lib.store.toJSON().files.some((f) => f.group === 'integration'));

    // ── A background project reruns on save ────────────────────────────────
    t.eq('web is shown', reg.selected.name, 'web');
    // Editor features decorate each file from its own project, not the selected one.
    const mathDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'packages', 'lib', 'src', 'math.test.js')));
    await vscode.window.showTextDocument(mathDoc);
    const keyOf = new Map([...api.decorationManager._decorations].map(([k, v]) => [v, k]));
    const gutter = {};
    api.decorationManager.applyToEditor({ document: mathDoc, setDecorations: (type, r) => { if (r.length) { gutter[keyOf.get(type)] = r.length; } } });
    t.eq('a lib file shows lib\'s results while web is selected', gutter, { 'status-passed': 2 });
    t.eq('…and lib\'s CodeLens', api.codeLensProvider.provideCodeLenses(mathDoc).filter((l) => l.command.title === '▶ Run').length, 2);
    const flow = path.join(workspace, 'packages', 'lib', 'test', 'flow.test.js');
    await h.editAndSave(vscode, flow, (s) => s.replace('toBe(3)', 'toBe(2)'));
    await h.waitFor(() => lib.store.getSummary().failed === 0 && !lib.session.isRunning(), { what: 'lib to rerun flow.test.js in the background', timeout: 60_000 });
    t.eq('the background rerun fixed lib\'s failure', counts(lib), { total: 5, passed: 5, failed: 0 });
    t.eq('web is still shown after the background rerun', reg.selected.name, 'web');

    // ── Stop everything ────────────────────────────────────────────────────
    await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    t.eq('Stop All Projects stops both', reg.contexts.map((c) => c.session.isActive()), [false, false]);
    await h.sleep(3000);
    const left = h.vitestProcesses(workspace);
    t.check('no Vitest process left', left.length === 0, left.join('\n'));
  },
};
