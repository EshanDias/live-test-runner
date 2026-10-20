const { add, multiply, divide } = require('./math');

describe('Math utils', () => {
  test('adds numbers', () => {
    console.log('adding ✓ ünïcödé');
    expect(add(1, 2)).toBe(3);
  });

  test('multiplies numbers', () => {
    console.log('multiplying');
    expect(multiply(2, 3)).toBe(6);
  });

  test('a^b | c & d', () => {
    expect(add(0, 0)).toBe(0);
  });

  test('divides numbers', () => {
    expect(divide(6, 3)).toBe(2);
  });

  test.skip('skipped test', () => {
    expect(true).toBe(false);
  });

  test.todo('todo test');
});

describe('Other suite', () => {
  test('adds numbers', () => {
    expect(add(2, 2)).toBe(4);
  });
});
