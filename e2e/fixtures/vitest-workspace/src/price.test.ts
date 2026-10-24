import { test, expect } from 'vitest';
import { total, withTax } from './price';

test('totals', () => {
  expect(total([1, 2])).toBe(3);
});

test('taxes', () => {
  expect(withTax(10)).toBe(12);
});
