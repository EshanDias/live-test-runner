'use strict';
/**
 * A monorepo with a Jest package, a Vitest package and a package that has
 * both configs (phase 7 + 8): each package is its own project with its own
 * framework(s); the mixed one runs each file with its framework.
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:mixed-monorepo',
  settings: { 'liveTestRunner.maxRunningProjects': 2 },
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const reg = api.projects;
    const byName = Object.fromEntries(reg.contexts.map((c) => [c.name, c]));
    t.eq('three projects', Object.keys(byName).sort(), ['api', 'shared', 'web']);
    t.eq('their frameworks', ['api', 'shared', 'web'].map((n) => byName[n].frameworkLabel), ['jest', 'jest + vitest', 'vitest']);
    try {
      await vscode.commands.executeCommand('liveTestRunner.selectProject', byName.shared.id);
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => !byName.shared.session.isRunning() && byName.shared.session.isActive(), { what: 'shared to run', timeout: 120_000 });
      t.eq('shared: old.test.js ran with Jest', h.statusCounts(api, 'old.test.js'), { passed: 1 });
      t.eq('shared: new.vitest.js ran with Vitest', h.statusCounts(api, 'new.vitest.js'), { passed: 1 });

      await vscode.commands.executeCommand('liveTestRunner.selectProject', byName.web.id);
      await h.waitForDiscovery(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await h.waitFor(() => !byName.web.session.isRunning() && byName.web.session.isActive(), { what: 'web to run', timeout: 120_000 });
      t.eq('web: web.test.js (Vitest)', h.statusCounts(api, 'web.test.js'), { passed: 1 });
      t.check('web is not mixed', !byName.web.services.isMixed());
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopAllProjects');
    }
    await h.sleep(3000);
    const left = h.jestProcesses(workspace).concat(h.vitestProcesses(workspace));
    t.check('no process left', left.length === 0, left.join('\n'));
  },
};
