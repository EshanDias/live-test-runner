import { test, expect } from 'vitest';
import { first } from './s.js';

test('first, from a second test file', () => {
  expect(first()).toBe('first');
});
