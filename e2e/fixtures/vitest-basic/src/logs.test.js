// Console output at every scope — Vitest attributes each line to its test / suite.
import { describe, it, beforeAll } from 'vitest';

console.log('module log');

describe('logs', () => {
  beforeAll(() => {
    console.log('setup log');
  });

  it('one', () => {
    console.log('one log');
  });

  it('two', () => {
    console.warn('two warning');
  });

  it('quiet', () => {});
});
