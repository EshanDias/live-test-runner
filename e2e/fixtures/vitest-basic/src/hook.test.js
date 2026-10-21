// A failing beforeAll: Vitest skips the suite's tests and fails the file.
import { describe, it, beforeAll } from 'vitest';

describe('hooked', () => {
  beforeAll(() => {
    throw new Error('setup broke');
  });

  it('never runs', () => {});
});
