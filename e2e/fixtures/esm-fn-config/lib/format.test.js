const { money } = require('~lib/format');

describe('format', () => {
  test('formats cents as money', () => {
    expect(money(1234)).toBe('$12.34');
  });
});
