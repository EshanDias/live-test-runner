'use strict';
/**
 * Jest's ESM mode (`NODE_OPTIONS=--experimental-vm-modules jest` in the test
 * script) with Svelte 4 components compiled by svelte-jester (processAsync,
 * ESM output):
 *   - the extension runs Jest with the test script's Node options — results
 *     match plain Jest (before, every ESM file failed to load);
 *   - instrumented ES modules load the trace runtime with an import;
 *   - covering tests at the component's own lines;
 *   - saving the .svelte file reruns only the tests that ran it.
 */
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

const key = (p) => p.replace(/^[A-Z]:/, (m) => m.toLowerCase());

async function waitIdle(api) {
  await h.sleep(1200); // debounce
  await h.waitFor(() => api.session._activeRuns === 0, { what: 'runs to finish', timeout: 120_000 });
  await h.sleep(300);
}

module.exports = {
  workspace: 'fixture:jest-svelte-esm',
  timeoutMs: 6 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const greeting = path.join(workspace, 'src', 'Greeting.svelte');
    const text = path.join(workspace, 'src', 'text.js');
    const original = fs.readFileSync(greeting, 'utf8');
    try {
      await h.waitForDiscovery(api);
      let since = h.isoNow();
      const mark = h.rawMark(api);
      await vscode.commands.executeCommand('liveTestRunner.startTesting');
      await waitIdle(api);
      let logs = h.logsSince(api, since);
      h.checkMatchesPlainJest(api, t, workspace);
      t.eq('greeting.test.js passes', h.statusCounts(api, 'src/greeting.test.js'), { passed: 1 });
      t.eq('text.test.js passes', h.statusCounts(api, 'src/text.test.js'), { passed: 1 });
      const raw = h.rawSince(api, mark).join('\n');
      t.check('no ESM loading errors', !/Cannot use import statement|require is not defined|CJS mode/.test(raw), raw.slice(-3000));

      const names = (file, line) => api.traceStore.getTestsForLine(key(file), line).map((e) => e.fullName).sort();
      t.eq('Greeting.svelte line 5 (return …) is covered by "greets loudly"', names(greeting, 5), ['greets loudly']);
      t.eq('text.js line 2 by both tests', names(text, 2), ['greets loudly', 'shouts']);
      await h.waitFor(() => api.coverageStore.isScanComplete(), { what: 'the source scan', timeout: 60_000 });
      const cov = api.coverageStore.getEntry(key(greeting));
      t.check('Greeting.svelte is measured', cov && cov.state === 'measured' && cov.pct.statements.covered > 0, JSON.stringify(cov && cov.pct));

      const rec = h.recordEvents(api);
      since = h.isoNow();
      await h.editAndSave(vscode, greeting, (s) => s + '\n<!-- touched -->\n');
      await waitIdle(api);
      logs = h.logsSince(api, since);
      t.check('saving Greeting.svelte: a trace-based rerun', logs.some((l) => /Trace-based rerun for Greeting\.svelte/.test(l)), logs.join('\n'));
      t.eq('…only greeting.test.js got a result', [...new Set(rec.of('file-result').map((e) => e.file))], ['greeting.test.js']);
      t.eq('…still passing', h.statusCounts(api, 'src/greeting.test.js'), { passed: 1 });
      rec.stop();
    } finally {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
      fs.writeFileSync(greeting, original);
    }
  },
};
