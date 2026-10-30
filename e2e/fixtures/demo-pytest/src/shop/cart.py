from shop.pricing import discount, with_tax


class Cart:
    def __init__(self) -> None:
        self.items: list[tuple[str, float, int]] = []

    def add(self, name: str, price: float, qty: int = 1) -> None:
        if qty < 1:
            raise ValueError("qty must be at least 1")
        self.items.append((name, price, qty))

    def subtotal(self) -> float:
        return round(sum(price * qty for _, price, qty in self.items), 2)

    def total(self, code: str = "") -> float:
        return with_tax(discount(self.subtotal(), code))
