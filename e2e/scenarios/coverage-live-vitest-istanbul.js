'use strict';
/** Coverage stays truthful while the session runs — Vitest with `coverage.provider: 'istanbul'` (checks: e2e/lib/coverageLive.js). */
const live = require('../lib/coverageLive');
const vitest = require('./coverage-live-vitest');

module.exports = { ...vitest, workspace: 'fixture:coverage-live-vitest-istanbul', run: (ctx) => live.run(ctx, vitest.spec) };
