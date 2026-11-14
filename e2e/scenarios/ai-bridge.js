'use strict';
/**
 * AI-assistant bridge on a Jest project: an agent (scripted MCP client
 * through the launcher) reads the failure, fixes the source on disk,
 * verifies, reruns; VS Code's language-model tools answer the same; the
 * failure is in the Problems list with Fix with AI. See lib/aiBridge.js.
 */
const { aiBridgeScenario } = require('../lib/aiBridge');

module.exports = {
  workspace: 'fixture:basic',
  timeoutMs: 6 * 60_000,
  run: (ctx) => aiBridgeScenario(ctx, {
    source: [
      'src/aiCart.js',
      'function total(items) {\n  return items.reduce((sum, item) => sum + item.cost.amount, 0);\n}\nmodule.exports = { total };\n',
      'function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nmodule.exports = { total };\n',
    ],
    test: [
      'src/aiCart.test.js',
      "const { total } = require('./aiCart');\ndescribe('cart', () => {\n  test('totals prices', () => {\n    expect(total([{ price: 2 }, { price: 3 }])).toBe(5);\n  });\n  test('empty cart', () => {\n    expect(total([])).toBe(0);\n  });\n});\n",
    ],
    failing: 'cart totals prices',
    trace: true,
  }),
};
