'use strict';
/** Jest: new test files / cases while the session is on, and ▶ Run after Stop (see lib/newTestsAndStop.js). */
const { newTestsAndStopScenario } = require('../lib/newTestsAndStop');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 5 * 60_000,
  run: (ctx) => newTestsAndStopScenario(ctx, {
    dir: 'src',
    file: (n) => `${n}.test.js`,
    body: ["test('one', () => { expect(1).toBe(1); });\n", "test('two', () => { expect(2).toBe(2); });\n"],
  }),
};
