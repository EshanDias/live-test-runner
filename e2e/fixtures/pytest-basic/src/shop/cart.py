class Cart:
    def __init__(self):
        self.items = []

    def add(self, name, price, qty=1):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.items.append((name, price, qty))

    def total(self):
        return sum(price * qty for _, price, qty in self.items)


def discount(total, code):
    if code == "HALF":
        return total / 2
    if code == "TENOFF":
        return max(total - 10, 0)
    return total
