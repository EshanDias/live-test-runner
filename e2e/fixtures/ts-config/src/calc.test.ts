import { total, average } from '@lib/calc';

describe('calc', () => {
  it('totals values', () => {
    console.log('totalling');
    expect(total([1, 2, 3])).toBe(6);
  });

  it('averages values', () => {
    expect(average([2, 4])).toBe(3);
  });

  it('averages nothing as zero', () => {
    expect(average([])).toBe(0);
  });
});
