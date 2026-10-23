import { expect, test } from 'vitest';
import { double } from './util.js';

test('doubles', () => {
  expect(double(4)).toBe(8);
});
