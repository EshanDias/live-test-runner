import { test, expect } from 'vitest';
import { onlyOther } from './e.js';

test('only other.test.js uses e.js', () => {
  expect(onlyOther()).toBe('e');
});
