'use strict';
/** AI-assistant bridge on a Vitest project (see ai-bridge.js and lib/aiBridge.js). */
const { aiBridgeScenario } = require('../lib/aiBridge');

module.exports = {
  workspace: 'fixture:vitest-basic',
  timeoutMs: 6 * 60_000,
  run: (ctx) => aiBridgeScenario(ctx, {
    source: [
      'src/aiCart.js',
      'export function total(items) {\n  return items.reduce((sum, item) => sum + item.cost.amount, 0);\n}\n',
      'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n',
    ],
    test: [
      'src/aiCart.test.js',
      "import { describe, test, expect } from 'vitest';\nimport { total } from './aiCart.js';\n\ndescribe('cart', () => {\n  test('totals prices', () => {\n    expect(total([{ price: 2 }, { price: 3 }])).toBe(5);\n  });\n  test('empty cart', () => {\n    expect(total([])).toBe(0);\n  });\n});\n",
    ],
    failing: 'cart totals prices',
    trace: true,
  }),
};
