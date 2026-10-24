import { test, expectTypeOf } from 'vitest';
import { total } from './price';

test('total returns a number', () => {
  expectTypeOf(total).returns.toBeNumber();
});
