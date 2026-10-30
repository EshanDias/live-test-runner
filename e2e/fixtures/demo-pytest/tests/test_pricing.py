import time

from shop.pricing import discount, with_tax


def test_with_tax():
    time.sleep(0.4)
    assert with_tax(10) == 12.0


def test_unknown_code_keeps_price():
    time.sleep(0.3)
    assert discount(10, "NOPE") == 10
