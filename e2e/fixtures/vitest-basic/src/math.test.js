import { describe, it, test, expect } from 'vitest';
import { add, divide } from './math.js';

describe('Math utils', () => {
  it('adds numbers', () => {
    console.log('adding ✓ ünïcödé');
    expect(add(1, 2)).toBe(3);
  });

  describe('divide', () => {
    it('divides', () => {
      expect(divide(6, 3)).toBe(2);
    });

    it('throws on zero', () => {
      expect(() => divide(1, 0)).toThrow('Division by zero');
    });
  });

  test.each([
    [1, 1, 2],
    [2, 3, 5],
  ])('add(%i, %i) = %i', (a, b, sum) => {
    expect(add(a, b)).toBe(sum);
  });

  it.skip('skipped test', () => {});
  it.todo('todo test');
});
