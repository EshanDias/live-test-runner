import { compareVersions, parseVersion, satisfies } from '../src/utils/semver';

describe('semver helper', () => {
  it('parses versions', () => {
    expect(parseVersion('v22.12.0')).toEqual([22, 12, 0]);
    expect(parseVersion('5.0.5')).toEqual([5, 0, 5]);
    expect(parseVersion('4.1.0-beta.1')).toEqual([4, 1, 0]);
    expect(parseVersion('22')).toEqual([22, 0, 0]);
    expect(parseVersion('latest')).toBeUndefined();
    expect(compareVersions([1, 2, 3], [1, 10, 0])).toBeLessThan(0);
  });

  it("reads Vitest 5's engines range", () => {
    const range = '^22.12.0 || ^24.0.0 || >=26.0.0';
    expect(satisfies('22.12.0', range)).toBe(true);
    expect(satisfies('22.11.9', range)).toBe(false);
    expect(satisfies('23.0.0', range)).toBe(false);
    expect(satisfies('24.13.0', range)).toBe(true);
    expect(satisfies('25.1.0', range)).toBe(false);
    expect(satisfies('26.0.0', range)).toBe(true);
    expect(satisfies('20.19.0', range)).toBe(false);
  });

  it('handles ~, <, <=, >, wildcards and comparator sets', () => {
    expect(satisfies('20.5.0', '^20.0.0 || ^22.0.0 || >=24.0.0')).toBe(true);
    expect(satisfies('22.13.1', '~22.12')).toBe(false);
    expect(satisfies('22.12.9', '~22.12.0')).toBe(true);
    expect(satisfies('18.0.0', '>=18 <20')).toBe(true);
    expect(satisfies('20.0.0', '>=18 <20')).toBe(false);
    expect(satisfies('22.9.0', '22.x')).toBe(true);
    expect(satisfies('23.0.0', '<=22')).toBe(false);
    expect(satisfies('22.99.0', '<=22')).toBe(true);
    expect(satisfies('23.0.0', '>22')).toBe(true);
    expect(satisfies('22.5.0', '>22')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('1.2.3', '*')).toBe(true);
  });

  it('says "unknown" for syntax it does not understand', () => {
    expect(satisfies('22.0.0', '22.0.0 - 24.0.0')).toBeUndefined();
    expect(satisfies('nope', '>=1')).toBeUndefined();
  });
});
