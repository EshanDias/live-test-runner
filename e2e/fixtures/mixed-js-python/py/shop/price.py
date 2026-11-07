def total(prices):
    return sum(prices)


def discount(price, pct):
    return round(price * (1 - pct / 100), 2)
