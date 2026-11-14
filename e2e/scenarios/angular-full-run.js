'use strict';
/**
 * Angular (Vitest through Angular's unit-test builder, `ng test`): a fresh
 * `ng new` workspace with an app and a library. Detected as Angular (not
 * plain Vitest, where every test failed with "describe is not defined"),
 * each project run with `ng test <project>`; results with line numbers,
 * per-test output, coverage, the failure on its line, a single test, a
 * source save rerunning the tests that import it; nothing written into the
 * project.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const CART_SPEC = 'src/app/cart.spec.ts';
const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

module.exports = {
  workspace: 'fixture:angular',
  timeoutMs: 8 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 300_000 });
    await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'the source scan', timeout: 60_000 });

    t.eq('cart.spec.ts results', h.statusCounts(api, CART_SPEC), { passed: 4, failed: 1 });
    t.eq('app.spec.ts results (TestBed, template)', h.statusCounts(api, 'src/app/app.spec.ts'), { passed: 2 });
    t.eq('the library\'s own project ran too', h.statusCounts(api, 'projects/mylib/src/lib/mylib.spec.ts'), { passed: 1 });
    const adds = h.nodeByName(api, CART_SPEC, 'Cart adds items');
    t.eq('the framework\'s line numbers', adds?.line, 8);
    t.check('console output of each test (Vitest attribution)', api.store.getNodeOutput(adds.id).lines.some((l) => /cart total 6/.test(l.text)),
      JSON.stringify(api.store.getNodeOutput(adds.id)));

    const cart = api.coverageStore.getEntry(key(path.join(workspace, 'src', 'app', 'cart.ts')));
    t.eq('coverage: src/app/cart.ts is measured', cart?.state, 'measured');
    t.check('…most of it covered', cart && cart.pct.statements.covered > 0 && cart.pct.statements.covered <= cart.pct.statements.total, JSON.stringify(cart?.pct));
    // Every number equals plain `ng test <project> --coverage` (run in a copy: it writes coverage/ and .angular/).
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    const plain = h.plainCoverage(workspace, 'angular');
    const four = (p) => p && ['statements', 'branches', 'functions', 'lines'].map((m) => `${m[0]} ${p[m].covered}/${p[m].total}`).join(', ');
    const got = new Map(api.coverageStore.getFileRows().map((r) => [path.relative(real(workspace), real(r.filePath)).split(path.sep).join('/'), r.pct]));
    const diffs = [...new Set([...plain.keys(), ...got.keys()])].sort()
      .filter((f) => four(got.get(f)) !== four(plain.get(f)))
      .map((f) => `${f}: extension ${four(got.get(f)) ?? '(none)'} · plain ng test ${four(plain.get(f)) ?? '(none)'}`);
    t.check(`every file's statements, branches, functions and lines equal plain ng test --coverage (${plain.size} files)`, plain.size > 0 && diffs.length === 0, diffs.join('\n'));

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, CART_SPEC)));
    const marks = api.failureDecorations.marks(doc);
    t.eq('the failure on its line, with both values', marks.map((m) => [m.line, m.failure.summary]), [[29, 'Expected 9, received 10']]);

    // ▶ Run on one test: only it runs.
    const halves = h.nodeByName(api, CART_SPEC, 'Cart discount halves with HALF');
    const mark = h.rawMark(api);
    await vscode.commands.executeCommand('liveTestRunner.rerunScope', { scope: 'test', fileId: halves.fileId, nodeId: halves.id, fullName: halves.fullName });
    const raw = h.rawSince(api, mark);
    t.check('▶ Run on one test runs only that test', raw.some((l) => /Tests\s+1 passed/.test(l)) && !raw.some((l) => /Tests.*failed/.test(l)), raw.filter((l) => /Tests/.test(l)).join('\n'));
    t.eq('…and it passed', api.store.getNode(halves.id).status, 'passed');

    // Saving a source file reruns the tests that import it (cart.spec.ts, app.spec.ts through app.ts), not the library's.
    const rec = h.recordEvents(api);
    const saveMark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'src', 'app', 'cart.ts'), (s) => s.replace('code === \'HALF\'', 'code === "HALF"'));
    await h.waitFor(() => rec.of('run-finished').length > 0, { what: 'the save rerun', timeout: 180_000 });
    const ran = h.rawSince(api, saveMark).join('\n');
    t.check('a source save reruns the test files that import it (cart.spec.ts, app.spec.ts through app.ts), not the library\'s',
      /cart\.spec\.ts/.test(ran) && /app\.spec\.ts/.test(ran) && !/mylib\.spec\.ts/.test(ran), ran.split('\n').filter((l) => /spec\.ts|Test Files/.test(l)).join('\n'));
    // A template is no import: its component's tests rerun (templateUrl).
    const rec2 = h.recordEvents(api);
    const htmlMark = h.rawMark(api);
    await h.editAndSave(vscode, path.join(workspace, 'src', 'app', 'app.html'), (s) => s.replace('<h1>', '<h1 class="title">'));
    await h.waitFor(() => rec2.of('run-finished').length > 0, { what: 'the template save rerun', timeout: 180_000 });
    const ranHtml = h.rawSince(api, htmlMark).join('\n');
    t.check('saving a template reruns its component\'s tests', /app\.spec\.ts/.test(ranHtml) && !/cart\.spec\.ts/.test(ranHtml), ranHtml.split('\n').filter((l) => /spec\.ts|Test Files/.test(l)).join('\n'));
    t.eq('nothing left running', h.nodesWithStatus(api, 'running').map((n) => n.id), []);

    t.check('nothing written into the project (no .angular/ cache, no coverage/ folder)',
      !fs.existsSync(path.join(workspace, '.angular')) && !fs.existsSync(path.join(workspace, 'coverage')), fs.readdirSync(workspace).join(', '));
  },
};
