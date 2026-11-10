import { Cart } from './cart';

describe('Cart', () => {
  it('starts empty', () => {
    expect(new Cart().total()).toBe(0);
  });

  it('adds items', () => {
    const cart = new Cart();
    cart.add('apple', 2, 3);
    console.log('cart total', cart.total());
    expect(cart.total()).toBe(6);
  });

  it('rejects a zero quantity', () => {
    expect(() => new Cart().add('pear', 1, 0)).toThrow('qty must be positive');
  });

  describe('discount', () => {
    it('halves with HALF', () => {
      const cart = new Cart();
      cart.add('plum', 10);
      expect(cart.discount('HALF')).toBe(5);
    });

    it('fails on purpose', () => {
      const cart = new Cart();
      cart.add('plum', 10);
      expect(cart.discount('NONE')).toBe(9);
    });
  });
});
