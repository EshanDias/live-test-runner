VAT = 0.2


def with_tax(amount: float) -> float:
    return round(amount * (1 + VAT), 2)


def discount(amount: float, code: str) -> float:
    rates = {"HALF": 0.5, "TENOFF": 0.9}
    return round(amount * rates.get(code, 1.0), 2)
