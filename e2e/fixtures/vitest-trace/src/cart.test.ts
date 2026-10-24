import { describe, expect, it } from 'vitest';
import { total } from './price';
import { money } from './format.js';

describe('cart', () => {
  it('totals', () => {
    expect(total([1, 2, 3])).toBe(6);
  });

  it('formats', () => {
    expect(money(5)).toBe('$5.00');
  });

  // A function serialised with toString() (page.evaluate, workers) must be
  // the code as written — no trace calls in it.
  it('serialises its source', () => {
    expect(total.toString()).not.toMatch(/__strace|ltr/);
    expect(new Function(`return (${total.toString()})`)()([2, 2])).toBe(4);
  });
});
