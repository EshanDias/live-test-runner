const { first } = require('./s');

test('first, from a second test file', () => {
  expect(first()).toBe('first');
});
