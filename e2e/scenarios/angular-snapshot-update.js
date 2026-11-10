'use strict';
/** Update snapshot for Angular (the builder has no -u: our runner config sets `update`): the same checks as snapshot-update. */
const { scenario } = require('./snapshot-update');

module.exports = {
  workspace: 'fixture:angular',
  timeoutMs: 6 * 60_000,
  run: (ctx) => scenario(ctx, 'vitest'),
};
