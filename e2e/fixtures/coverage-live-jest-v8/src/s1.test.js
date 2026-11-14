const { first, second } = require('./s');

test('first', () => {
  expect(first()).toBe('first');
});

test('second', () => {
  expect(second()).toBe('second');
});
