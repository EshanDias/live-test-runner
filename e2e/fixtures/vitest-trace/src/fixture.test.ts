import { expect, test } from 'vitest';
import { withTax } from './price';

// Vitest parses fixture functions' parameters: the trace setup file's hooks must not upset it.
const it = test.extend<{ amount: number }>({
  // eslint-disable-next-line no-empty-pattern
  amount: async ({}, use) => { await use(10); },
});

it('taxes a fixture amount', ({ amount }) => {
  expect(withTax(amount)).toBe(12);
});
