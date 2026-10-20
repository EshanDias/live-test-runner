const { add } = require('./math');
const { shout } = require('./strings');

// Each test uses a different module, so saving strings.js must rerun only the
// tests that call into it.
describe('Mixed', () => {
  test('uses math', () => {
    console.log('mixed-math');
    expect(add(1, 1)).toBe(2);
  });

  test('uses strings', () => {
    console.log('mixed-strings');
    expect(shout('x')).toBe('X');
  });

  test('uses both', () => {
    console.log('mixed-both');
    expect(shout(String(add(1, 2)))).toBe('3');
  });
});
