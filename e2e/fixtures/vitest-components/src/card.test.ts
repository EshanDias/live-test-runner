import { test, expect } from 'vitest';
import { template } from './card';

test('card template', () => {
  expect(template).toContain('card');
});
