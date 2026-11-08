const { greet } = require('./greet');

test('greets', () => {
  expect(greet('Ada')).toBe('Hello, Ada');
});
