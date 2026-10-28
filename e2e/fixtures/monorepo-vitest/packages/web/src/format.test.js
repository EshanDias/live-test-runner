import { describe, test, expect } from 'vitest';
import { price } from './format.js';

describe('price', () => {
  test('formats cents', () => { expect(price(1234)).toBe('$12.34'); });
  test('formats zero', () => { expect(price(0)).toBe('$0.00'); });
});
