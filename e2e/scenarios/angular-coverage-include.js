'use strict';
/**
 * Angular with `coverageInclude` on each project's test target: `ng test
 * --coverage` then also lists the files no test loads (0%). Every file's
 * numbers equal plain `ng test <project> --coverage`, for both projects of
 * the workspace (the app and the library each run their own `ng test`).
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:angular',
  timeoutMs: 8 * 60_000,

  prepare([workspace]) {
    const file = path.join(workspace, 'angular.json');
    const ng = JSON.parse(fs.readFileSync(file, 'utf8'));
    const test = (name) => ng.projects[name].architect.test;
    test('shop').options = { ...(test('shop').options || {}), coverageInclude: ['src/**/*.ts'] };
    test('mylib').options = { ...(test('mylib').options || {}), coverageInclude: ['projects/mylib/src/**/*.ts'] };
    fs.writeFileSync(file, JSON.stringify(ng, null, 2));
  },

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session.isActive() && !api.session.isRunning(), { what: 'the full run', timeout: 300_000 });

    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    const rel = (p) => path.relative(real(workspace), real(p)).split(path.sep).join('/');
    const four = (p) => p && ['statements', 'branches', 'functions', 'lines'].map((m) => `${m[0]} ${p[m].covered}/${p[m].total}`).join(', ');
    const compare = (what) => {
      const plain = h.plainCoverage(workspace, 'angular');
      const got = new Map(api.coverageStore.getFileRows().map((r) => [rel(r.filePath), r.pct]));
      const diffs = [...new Set([...plain.keys(), ...got.keys()])].sort()
        .filter((f) => four(got.get(f)) !== four(plain.get(f)))
        .map((f) => `${f}: extension ${four(got.get(f)) ?? '(none)'} · plain ng test ${four(plain.get(f)) ?? '(none)'}`);
      t.check(`${what}: every file equals plain ng test --coverage (${plain.size} files)`, plain.size > 0 && diffs.length === 0, diffs.join('\n'));
      return plain;
    };

    const plain = compare('after the full run');
    t.check('files no test loads are listed (src/main.ts, app.config.ts, app.routes.ts)',
      ['src/main.ts', 'src/app/app.config.ts', 'src/app/app.routes.ts'].every((f) => plain.has(f)), [...plain.keys()].join(', '));

    // A new source file no test loads: 0%, as ng test would count it.
    fs.writeFileSync(path.join(workspace, 'src', 'app', 'extra.ts'), 'export function extra(n: number): number {\n  return n > 1 ? n * 2 : n;\n}\n');
    await h.waitFor(() => api.coverageStore.getFileRows().some((r) => rel(r.filePath) === 'src/app/extra.ts'), { what: 'the new file counted', timeout: 90_000 });
    compare('after a new source file');
  },
};
