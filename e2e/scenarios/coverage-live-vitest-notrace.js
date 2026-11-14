'use strict';
/**
 * Coverage stays truthful with the Vitest execution trace turned off
 * (`liveTestRunner.vitestTrace: false`): the same checks as coverage-live-vitest
 * (e2e/lib/coverageLive.js) — coverage is kept per test file whether or not
 * lines are traced.
 */
const live = require('../lib/coverageLive');
const vitest = require('./coverage-live-vitest');

module.exports = {
  ...vitest,
  settings: { 'liveTestRunner.vitestTrace': false },
  run: (ctx) => live.run(ctx, { ...vitest.spec, related: /running the tests related to/ }),
};
