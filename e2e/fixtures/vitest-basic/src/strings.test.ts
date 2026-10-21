import { describe, expect, it } from 'vitest';

const shout = (s: string): string => `${s.toUpperCase()}!`;

describe('strings', () => {
  it('shouts', () => {
    expect(shout('hi')).toBe('HI!');
  });

  it('fails on purpose', () => {
    expect(shout('hi')).toBe('hi');
  });
});
