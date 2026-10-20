const { matchesSource } = require('./invoice');

describe('matchesSource', () => {
  test('matches case-insensitively', () => {
    expect(matchesSource({ SOURCE: 'SoftCo Upload' }, 'SOFTCO')).toBe(true);
  });

  test('handles missing values', () => {
    expect(matchesSource(undefined, 'x')).toBeUndefined();
    expect(matchesSource({}, 'x')).toBeUndefined();
  });
});
