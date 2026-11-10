export class Cart {
  private readonly items: { name: string; price: number; qty: number }[] = [];

  add(name: string, price: number, qty = 1): void {
    if (qty <= 0) {
      throw new Error('qty must be positive');
    }
    this.items.push({ name, price, qty });
  }

  total(): number {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  discount(code: string): number {
    return code === 'HALF' ? this.total() / 2 : this.total();
  }
}
