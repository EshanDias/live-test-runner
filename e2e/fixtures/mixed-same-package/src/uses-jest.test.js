// Both configs list *.test.js; the jest.fn call sends it to Jest.
const { add } = require('./math');

test('runs with Jest', () => {
  const fn = jest.fn();
  fn(add(1, 1));
  expect(fn).toHaveBeenCalledWith(2);
});

test('a failing Jest test', () => {
  expect(add(1, 1)).toBe(3);
});
