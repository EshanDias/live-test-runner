'use strict';
/** Not a test: records the vitest demo clips (see e2e/lib/demo.js). */
const { recordDemo, SETTINGS } = require('../lib/demo');

module.exports = {
  workspace: 'fixture:demo-vitest',
  timeoutMs: 6 * 60_000,
  settings: SETTINGS,
  run: (ctx) => recordDemo(ctx, {
    fw: 'vitest',
    testFile: 'src/cart.test.ts',
    sourceFile: 'src/pricing.ts',
    edit: { after: 'const VAT = 0.2', text: '5' },
    hover: { file: 'src/cart.ts', find: 'return withTax' },
    output: { file: 'src/cart.test.ts', fullName: 'Cart total includes tax' },
  }),
};
