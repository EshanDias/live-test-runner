'use strict';
/**
 * Timeline Debugger (BUG-12) on Windows-style paths with spaces, for a plain
 * test and a test.each template, through the real command.
 */
const h = require('../lib/harness');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 4 * 60_000,

  async run({ api, t, vscode, workspace }) {
    await h.waitForDiscovery(api);

    const plain = h.nodeByName(api, 'src/math.test.js', 'Math utils adds numbers');
    const s1 = await api.instrumentedRunner.run({ filePath: plain.fileId, testFullName: plain.fullName, projectRoot: workspace });
    t.check('BUG-12 steps recorded for "Math utils adds numbers"', s1.steps.length > 0, `steps: ${s1.steps.length}`);
    t.check('BUG-12 steps reach the source file math.js', s1.steps.some((s) => /math\.js$/.test(s.file)),
      JSON.stringify([...new Set(s1.steps.map((s) => s.file))]));
    const otherSuite = s1.steps.filter((s) => s.line === 31 && /math\.test\.js$/.test(s.file)); // body of "Other suite adds numbers"
    t.eq('BUG-12 only the chosen test ran (not "Other suite adds numbers")', otherSuite.length, 0);

    const each = h.nodeByName(api, 'src/strings.test.js', 'Strings shout(%s) is %s');
    const s2 = await api.instrumentedRunner.run({ filePath: each.fileId, testFullName: each.fullName, projectRoot: workspace });
    t.check('BUG-12 steps recorded for a test.each template', s2.steps.length > 0, `steps: ${s2.steps.length}`);

    // Through the command, as the Results panel does.
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.openTimelineDebugger', plain.fileId, plain.fullName);
    const logs = h.logsSince(api, since);
    t.check('BUG-12 command reports steps (no "captured 0 steps")', logs.some((l) => /Trace done in .* — \d+ steps/.test(l)) &&
      !logs.some((l) => /captured 0 steps/.test(l)), logs.join('\n'));
    t.check('BUG-12 TRACE_OUTPUT_FILE not left in the extension host env', !process.env.TRACE_OUTPUT_FILE, process.env.TRACE_OUTPUT_FILE);
  },
};
