'use strict';
/** Update snapshot for Vitest: the same checks as snapshot-update (Jest). */
const { scenario } = require('./snapshot-update');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 4 * 60_000,
  run: (ctx) => scenario(ctx, 'vitest'),
};
