// Vitest-only syntax that static discovery must understand (task 2.5).
import { describe, expect, test as base } from 'vitest';

const test = base.extend<{ answer: number }>({
  answer: async ({}, use) => {
    await use(42);
  },
});

describe('vitest syntax', () => {
  test('fixture value', ({ answer }) => {
    expect(answer).toBe(42);
  });

  test.for([1, 2])('for row %i', (n) => {
    expect(n).toBeGreaterThan(0);
  });

  test.skipIf(true)('skipped by skipIf', () => {});

  test.runIf(true)('run by runIf', () => {});
});
