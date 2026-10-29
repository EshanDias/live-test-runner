const VAT = 0.2;

export function withTax(amount: number): number {
  return Math.round(amount * (1 + VAT) * 100) / 100;
}

export function discount(amount: number, code: string): number {
  const rates: Record<string, number> = { HALF: 0.5, TENOFF: 0.9 };
  return Math.round(amount * (rates[code] ?? 1) * 100) / 100;
}
