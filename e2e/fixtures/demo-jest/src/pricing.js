const VAT = 0.2;

function withTax(amount) {
  return Math.round(amount * (1 + VAT) * 100) / 100;
}

function discount(amount, code) {
  const rates = { HALF: 0.5, TENOFF: 0.9 };
  return Math.round(amount * (rates[code] ?? 1) * 100) / 100;
}

module.exports = { withTax, discount };
