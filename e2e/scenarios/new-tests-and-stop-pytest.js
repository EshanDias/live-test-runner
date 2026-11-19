'use strict';
/** pytest: new test files / cases while the session is on, and ▶ Run after Stop (see lib/newTestsAndStop.js). */
const { newTestsAndStopScenario } = require('../lib/newTestsAndStop');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 5 * 60_000,
  run: (ctx) => newTestsAndStopScenario(ctx, {
    dir: 'tests',
    file: (n) => `test_${n}.py`,
    body: ['def test_one():\n    assert True\n', '\n\ndef test_two():\n    assert True\n'],
  }),
};
