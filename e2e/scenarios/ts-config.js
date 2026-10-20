'use strict';
/**
 * jest.config.ts + ts-jest + a path alias that exists only in that config
 * (BUG-07): the instrumented run must load it — no "no results" fallback, and
 * coverage / trace for the TypeScript source. Also the Timeline (BUG-12) on
 * a TypeScript test.
 */
const path = require('path');
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:ts-config',
  timeoutMs: 5 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    const logs = h.logsSince(api, since);

    t.eq('BUG-07 calc.test.ts passes (jest.config.ts alias resolved)', h.statusCounts(api, 'src/calc.test.ts'), { passed: 3 });
    const bad = logs.filter((l) => /returned no results|falling back to plain Jest|failed to run/.test(l));
    t.check('BUG-07 instrumented run used the TS config (no fallback)', bad.length === 0, bad.join('\n'));

    const calc = path.join(workspace, 'src', 'lib', 'calc.ts').replace(/^[A-Z]:/, (m) => m.toLowerCase());
    const cov = api.coverageStore.getEntry(calc);
    t.check('BUG-07 coverage measured for src/lib/calc.ts', cov && cov.state === 'measured', JSON.stringify(cov));

    // Timeline on a TypeScript test.
    const test = h.nodeByName(api, 'src/calc.test.ts', 'calc totals values');
    const store = await api.instrumentedRunner.run({ filePath: test.fileId, testFullName: test.fullName, projectRoot: workspace });
    t.check('BUG-12 timeline recorded steps for a ts-jest test', store.steps.length > 0, `steps: ${store.steps.length}`);
    t.check('BUG-12 timeline steps include the source file', store.steps.some((s) => /calc\.ts$/.test(s.file)),
      JSON.stringify([...new Set(store.steps.map((s) => s.file))]));
    t.check('BUG-12 TRACE_OUTPUT_FILE not left in the extension host env', !process.env.TRACE_OUTPUT_FILE, process.env.TRACE_OUTPUT_FILE);
  },
};
