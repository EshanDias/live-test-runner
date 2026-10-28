// Only Jest lists *.jest.js — it runs with Jest.
const { add } = require('./math');

describe('add (Jest)', () => {
  test('adds', () => {
    expect(add(1, 2)).toBe(3);
  });

  test('a jest.fn spy', () => {
    const spy = jest.fn(add);
    spy(2, 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
