import { describe, test, expect } from 'vitest';
import { next } from './counter.js';

// The tests share `count`: the second depends on the first. Saving counter.js
// must rerun the whole file, never the second test alone.
describe('counter', () => {
  let count = 0;

  test('first', () => {
    count = next(count);
    expect(count).toBe(1);
  });

  test('second', () => {
    count = next(count);
    expect(count).toBe(2);
  });

  test('unrelated', () => {
    expect(true).toBe(true);
  });
});
