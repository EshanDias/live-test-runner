import { nameToPattern } from '../src/utils/testNames';

const matches = (name: string, actual: string) => new RegExp(`^(?:${nameToPattern(name)})$`).test(actual);

describe('nameToPattern', () => {
  it('matches a plain name literally', () => {
    expect(matches('Math utils adds numbers', 'Math utils adds numbers')).toBe(true);
    expect(matches('Math utils adds numbers', 'Math utils adds numbersX')).toBe(false);
  });

  it('escapes regex characters', () => {
    expect(matches('a^b | c & d (x) [y] $5.00', 'a^b | c & d (x) [y] $5.00')).toBe(true);
    expect(matches('a.b', 'aXb')).toBe(false);
  });

  it('expands printf placeholders of test.each', () => {
    expect(matches('shout(%s) is %s', 'shout(a) is A')).toBe(true);
    expect(matches('%# case %p', '3 case {"a":1}')).toBe(true);
  });

  it('expands $variable placeholders of it.each`table`', () => {
    expect(matches('case $case', 'case 1')).toBe(true);
    expect(matches('for $item.name item', 'for workspace item')).toBe(true);
  });

  it('expands discovery placeholders', () => {
    expect(matches('renders <dynamic>', 'renders Home')).toBe(true);
    expect(matches('total …', 'total 12')).toBe(true);
  });
});
