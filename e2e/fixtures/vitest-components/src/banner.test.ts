import { test, expect } from 'vitest';
import { banner } from './banner';

test('shows the banner', () => {
  expect(banner()).toContain('Sale');
});
