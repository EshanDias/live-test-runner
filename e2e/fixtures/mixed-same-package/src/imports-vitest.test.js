// Both configs list *.test.js; the import from 'vitest' sends it to Vitest.
import { describe, test, expect } from 'vitest';
import { mul } from './math.js';

describe('imports vitest', () => {
  test('runs with Vitest', () => {
    expect(typeof import.meta).toBe('object');
    expect(mul(3, 3)).toBe(9);
  });
});
