const { classify, pick, sw, safe, twice, Box, later } = require('./branches');

test('some branches', async () => {
  expect(classify(5)).toBe('small items');
  expect(classify(-1)).toBe('negative');
  expect(pick({ a: { b: 1 } })).toBe(1);
  expect(sw('a')).toBe(1);
  expect(safe(() => 3)).toBe(3);
  expect(twice(2)).toBe(4);
  expect(new Box(1).get()).toBe(1);
  expect(await later(2)).toBe(2);
});
