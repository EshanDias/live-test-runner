export function total(items: number[]): number {
  let sum = 0;
  for (const i of items) {
    sum += i;
  }
  return sum;
}

export function withTax(amount: number): number {
  return Math.round(amount * 1.2);
}
