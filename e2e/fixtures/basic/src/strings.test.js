const { greet, shout } = require('./strings');

describe('Strings', () => {
  test('greets by name', () => {
    console.log('greeting');
    expect(greet('Ada')).toBe('Hello, Ada!');
  });

  test('shouts', () => {
    expect(shout('hi')).toBe('HI');
  });

  test.each([
    ['a', 'A'],
    ['b', 'B'],
  ])('shout(%s) is %s', (input, expected) => {
    expect(shout(input)).toBe(expected);
  });
});
