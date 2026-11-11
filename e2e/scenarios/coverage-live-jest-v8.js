'use strict';
/** Coverage stays truthful while the session runs — Jest with `coverageProvider: 'v8'` (checks: e2e/lib/coverageLive.js). */
const live = require('../lib/coverageLive');
const jest = require('./coverage-live');

module.exports = { ...jest, workspace: 'fixture:coverage-live-jest-v8', run: (ctx) => live.run(ctx, jest.spec) };
