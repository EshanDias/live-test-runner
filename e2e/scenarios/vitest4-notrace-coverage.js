'use strict';
/**
 * Coverage stays truthful on Vitest 4 with the execution trace off
 * (`liveTestRunner.vitestTrace: false`): the coverage-live checks
 * (e2e/lib/coverageLive.js) through `vitest related` reruns, on the
 * coverage-vitest4 fixture (the coverage-live-vitest files, Vitest 4.1).
 * The per-test-file provider loads here, so there is no fallback to merged
 * coverage (projects where Vitest cannot load it get one warning; vueuse in
 * the real-repo matrix).
 */
const live = require('../lib/coverageLive');
const h = require('../lib/harness');
const vitest = require('./coverage-live-vitest');

module.exports = {
  workspace: 'fixture:coverage-vitest4',
  timeoutMs: 5 * 60_000,
  settings: { 'liveTestRunner.vitestTrace': false },
  async run(ctx) {
    const since = h.isoNow();
    await live.run(ctx, { ...vitest.spec, related: /running the tests related to/ });
    const t = ctx.t;
    t.check('coverage stayed per test file (no fallback to merged)',
      !h.logsSince(ctx.api, since).some((l) => /ran nothing with the per-test-file coverage provider/.test(l)));
  },
};
