'use strict';
/** Not a test: records the jest demo clips (see e2e/lib/demo.js). */
const { recordDemo, SETTINGS } = require('../lib/demo');

module.exports = {
  workspace: 'fixture:demo-jest',
  timeoutMs: 6 * 60_000,
  settings: SETTINGS,
  run: (ctx) => recordDemo(ctx, {
    fw: 'jest',
    testFile: 'src/cart.test.js',
    sourceFile: 'src/pricing.js',
    edit: { after: 'const VAT = 0.2', text: '5' },
    hover: { file: 'src/cart.js', find: 'return withTax' },
    output: { file: 'src/cart.test.js', fullName: 'Cart total includes tax' },
  }),
};
