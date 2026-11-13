import { test, expect } from 'vitest';
import { first, second } from './s.js';

test('first', () => {
  expect(first()).toBe('first');
});

test('second', () => {
  expect(second()).toBe('second');
});
