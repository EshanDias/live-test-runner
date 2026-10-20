// Learnt from vscode-jest: it.each`table` names use $variables (discovery
// sees "add($a, $b) is $sum", Jest reports "add(1, 1) is 2"), and Jest allows
// two tests with the same full name. Both once made results disappear.
const { add } = require('./math');

describe('table', () => {
  it.each`
    a    | b    | sum
    ${1} | ${1} | ${2}
    ${2} | ${3} | ${5}
  `('add($a, $b) is $sum', ({ a, b, sum }) => {
    expect(add(a, b)).toBe(sum);
  });

  test('same name', () => {
    expect(add(1, 0)).toBe(1);
  });

  test('same name', () => {
    expect(add(0, 1)).toBe(1);
  });
});
