import { test, expect } from 'vitest';
import { double } from './util.js';

test('doubles', () => {
  expect(double(2)).toBe(4);
});
