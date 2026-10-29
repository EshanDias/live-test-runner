const { withTax, discount } = require('./pricing');

class Cart {
  items = [];

  add(name, price, qty = 1) {
    if (qty < 1) throw new Error('qty must be at least 1');
    this.items.push({ name, price, qty });
  }

  subtotal() {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  total(code = '') {
    return withTax(discount(this.subtotal(), code));
  }
}

module.exports = { Cart };
