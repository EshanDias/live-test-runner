import { discount, withTax } from './pricing';

export interface Item { name: string; price: number; qty: number }

export class Cart {
  items: Item[] = [];

  add(name: string, price: number, qty = 1): void {
    if (qty < 1) throw new Error('qty must be at least 1');
    this.items.push({ name, price, qty });
  }

  subtotal(): number {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  total(code = ''): number {
    return withTax(discount(this.subtotal(), code));
  }
}
