'use strict';
/**
 * Coverage on a pytest project (fixture pytest-basic: `[tool.coverage.run]
 * source = ["src"]`, `branch = true`): the plugin measures with the
 * project's own coverage.py and settings; the gutter / hover / totals model
 * gets each source file (an untested one at 0, as coverage.py reports it),
 * test files and conftest.py stay out, the totals equal coverage.py's own
 * report of a plain run, and nothing is written into the project.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('../lib/harness');

/** coverage.py's own totals for a plain `coverage run -m pytest` of the project (data in a temp folder). */
function plainCoverage(workspace) {
  const python = h.workspacePython(workspace);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-e2e-cov-'));
  const data = path.join(dir, '.coverage');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  spawnSync(python, ['-m', 'coverage', 'run', `--data-file=${data}`, '-m', 'pytest', '-p', 'no:cacheprovider', '--continue-on-collection-errors', '-q'], { cwd: workspace, env, encoding: 'utf8' });
  const out = path.join(dir, 'coverage.json');
  spawnSync(python, ['-m', 'coverage', 'json', `--data-file=${data}`, '-o', out], { cwd: workspace, env, encoding: 'utf8' });
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return json;
}

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    // The coverage store's spelling: the editor's path, lower-case drive letter (as for Vitest).
    const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'coverage to settle', timeout: 60_000 });

    const cartPy = key(path.join(workspace, 'src', 'shop', 'cart.py'));
    const cart = api.coverageStore.getEntry(cartPy);
    t.eq('src/shop/cart.py is measured', cart?.state, 'measured');
    t.check('…every statement covered (the tests call all of it)', cart && cart.pct.statements.total > 0 && cart.pct.statements.covered === cart.pct.statements.total, JSON.stringify(cart?.pct));
    t.check('…branches measured (branch = true in the project config)', cart && cart.pct.branches.total > 0, JSON.stringify(cart?.pct));
    t.check('…functions measured (coverage ≥ 7.6 regions)', cart && cart.pct.functions.total >= 4, JSON.stringify(cart?.pct));
    t.check('…with a manifest on disk (gutter / hover read it)', cart && fs.existsSync(cart.manifestPath), cart?.manifestPath);

    const untested = api.coverageStore.getEntry(key(path.join(workspace, 'src', 'shop', 'untested.py')));
    t.check('an untested source file counts at 0 % (coverage.py reports it: source is set)',
      untested && untested.pct && untested.pct.statements.total > 0 && untested.pct.statements.covered === 0, JSON.stringify(untested));
    for (const rel of ['tests/test_cart.py', 'tests/conftest.py']) {
      t.check(`${rel} is not counted`, !api.coverageStore.getEntry(key(path.join(workspace, ...rel.split('/')))));
    }

    const plain = plainCoverage(workspace);
    const totals = api.coverageStore.getTotals();
    const src = Object.entries(plain.files).filter(([f]) => f.replace(/\\/g, '/').startsWith('src/'));
    const want = src.reduce((a, [, f]) => ({ total: a.total + f.summary.num_statements, covered: a.covered + f.summary.covered_lines }), { total: 0, covered: 0 });
    t.eq("statement totals equal coverage.py's own report", { total: totals.statements.total, covered: totals.statements.covered }, want);

    // Hover on a branch line: discount()'s `if code == "HALF"` — both arms taken.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'src', 'shop', 'cart.py')));
    await vscode.window.showTextDocument(doc);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(14, 6));
    const text = (hovers || []).flatMap((hv) => hv.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    t.check('hover on a covered line says so', /covered/i.test(text) && !/not covered/i.test(text), text);
    t.check('…and no hit count (coverage.py records whether, not how often)', !/×\s*\d/.test(text), text);

    for (const p of ['.coverage', 'htmlcov', 'coverage.json', 'coverage.xml']) {
      t.check(`no ${p} written into the project`, !fs.existsSync(path.join(workspace, p)));
    }
  },
};
