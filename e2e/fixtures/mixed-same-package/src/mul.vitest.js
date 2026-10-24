// Only Vitest lists *.vitest.js — it runs with Vitest.
import { describe, test, expect, vi } from 'vitest';
import { mul } from './math.js';

describe('mul (Vitest)', () => {
  test('multiplies', () => {
    expect(mul(2, 3)).toBe(6);
  });

  test('a vi.fn spy', () => {
    const spy = vi.fn(mul);
    spy(2, 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
