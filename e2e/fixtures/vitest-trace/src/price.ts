export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export const withTax = (amount: number): number => amount * 1.2;
