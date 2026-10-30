import time

import pytest

from shop.cart import Cart


@pytest.fixture
def cart():
    c = Cart()
    c.add("book", 12.50, 2)
    c.add("pen", 5.00)
    return c


class TestCart:
    def test_subtotal(self, cart):
        time.sleep(0.4)
        assert cart.subtotal() == 30.0

    def test_total_includes_tax(self, cart):
        time.sleep(0.4)
        print(f"items: {cart.items}")
        print(f"total: {cart.total()}")
        assert cart.total() == 36.0

    @pytest.mark.parametrize("qty", [0, -1])
    def test_rejects_bad_qty(self, qty):
        time.sleep(0.3)
        with pytest.raises(ValueError):
            Cart().add("pen", 1.0, qty)


@pytest.mark.parametrize("code, expected", [("HALF", 18.0), ("TENOFF", 32.4), ("", 36.0)])
def test_discount_codes(cart, code, expected):
    time.sleep(0.3)
    assert cart.total(code) == expected
