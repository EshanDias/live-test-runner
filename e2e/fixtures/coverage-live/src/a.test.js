const { one, two } = require('./a');

test('one', () => {
  expect(one(1)).toBe(2);
});

test('two', () => {
  expect(two(2)).toBe(4);
});

// Uses nothing from a.js: saving a.js reruns `one` by name only.
test('unrelated', () => {
  expect([1, 2].length).toBe(2);
});
