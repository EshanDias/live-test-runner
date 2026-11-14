'use strict';
/** AI-assistant bridge on a pytest project (see ai-bridge.js and lib/aiBridge.js). */
const { aiBridgeScenario } = require('../lib/aiBridge');

module.exports = {
  workspace: 'fixture:pytest-basic',
  timeoutMs: 6 * 60_000,
  run: (ctx) => aiBridgeScenario(ctx, {
    source: [
      'src/shop/ai_cart.py',
      'def total(items):\n    return sum(item["cost"]["amount"] for item in items)\n',
      'def total(items):\n    return sum(item["price"] for item in items)\n',
    ],
    test: [
      'tests/test_ai_cart.py',
      'from shop.ai_cart import total\n\n\ndef test_totals_prices():\n    assert total([{"price": 2}, {"price": 3}]) == 5\n\n\ndef test_empty_cart():\n    assert total([]) == 0\n',
    ],
    failing: 'test_totals_prices',
    trace: true,
  }),
};
