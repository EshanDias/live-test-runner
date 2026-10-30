import { describe, expect, test } from 'vitest';
import { discount, withTax } from './pricing';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('pricing', () => {
  test('adds 20% tax', async () => {
    await pause(400);
    expect(withTax(10)).toBe(12);
  });

  test('an unknown code keeps the price', async () => {
    await pause(300);
    expect(discount(10, 'NOPE')).toBe(10);
  });
});
