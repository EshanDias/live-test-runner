'use strict';
/** Not a test: records the pytest demo clips (see e2e/lib/demo.js). */
const { recordDemo, SETTINGS } = require('../lib/demo');

module.exports = {
  workspace: 'fixture:demo-pytest',
  timeoutMs: 6 * 60_000,
  settings: SETTINGS,
  run: (ctx) => recordDemo(ctx, {
    fw: 'pytest',
    testFile: 'tests/test_cart.py',
    sourceFile: 'src/shop/pricing.py',
    edit: { after: 'VAT = 0.2', text: '5' },
    hover: { file: 'src/shop/cart.py', find: 'return with_tax' },
    output: { file: 'tests/test_cart.py', fullName: 'TestCart test_total_includes_tax' },
  }),
};
