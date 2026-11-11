'use strict';
/** Coverage stays truthful while the session runs — pytest with coverage.py's line coverage only (no `branch = true`; checks: e2e/lib/coverageLive.js). */
const live = require('../lib/coverageLive');
const pytest = require('./coverage-live-pytest');

module.exports = { ...pytest, workspace: 'fixture:coverage-live-pytest-nobranch', run: (ctx) => live.run(ctx, pytest.spec) };
