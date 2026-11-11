'use strict';
/**
 * Coverage stays truthful on Vitest 4 (execution trace on): the coverage-live
 * checks (e2e/lib/coverageLive.js) on the coverage-vitest4 fixture. Vitest 4
 * writes a merged report even when a related run finds no test — it must not
 * keep a source covered by a test file that is gone.
 */
const live = require('../lib/coverageLive');
const vitest = require('./coverage-live-vitest');

module.exports = {
  workspace: 'fixture:coverage-vitest4',
  timeoutMs: 5 * 60_000,
  run: (ctx) => live.run(ctx, vitest.spec),
};
