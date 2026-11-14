const { onlyOther } = require('./e');

test('only other.test.js uses e.js', () => {
  expect(onlyOther()).toBe('e');
});
