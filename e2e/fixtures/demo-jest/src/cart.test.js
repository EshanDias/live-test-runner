const { Cart } = require('./cart');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Cart', () => {
  let cart;
  beforeEach(() => {
    cart = new Cart();
    cart.add('book', 12.5, 2);
    cart.add('pen', 5);
  });

  test('adds up the subtotal', async () => {
    await pause(400);
    expect(cart.subtotal()).toBe(30);
  });

  test('total includes tax', async () => {
    await pause(400);
    console.log('items:', cart.items.length, 'total:', cart.total());
    expect(cart.total()).toBe(36);
  });

  test('rejects a bad quantity', async () => {
    await pause(300);
    expect(() => cart.add('pen', 1, 0)).toThrow('qty must be at least 1');
  });

  test.each([
    ['HALF', 18],
    ['TENOFF', 32.4],
    ['', 36],
  ])('discount code %p', async (code, expected) => {
    await pause(300);
    expect(cart.total(code)).toBe(expected);
  });
});
