import logging
import sys

import pytest

from shop.cart import Cart, discount

print("module-level print in test_cart")


class TestCart:
    def test_empty(self, cart):
        assert cart.total() == 0

    def test_add(self, cart):
        print("adding apples")
        cart.add("apple", 2, 3)
        assert cart.total() == 6

    @pytest.mark.parametrize("qty", [0, -1])
    def test_rejects_bad_qty(self, cart, qty):
        with pytest.raises(ValueError):
            cart.add("pear", 1, qty)

    def test_fails_on_purpose(self, cart):
        cart.add("plum", 5)
        print("total is", cart.total())
        print("to stderr", file=sys.stderr)
        assert cart.total() == 4

    class TestNested:
        def test_inner(self):
            assert Cart().items == []


@pytest.mark.parametrize(
    "code, expected",
    [
        ("HALF", 50),
        ("TENOFF", 90),
        ("NONE", 100),
    ],
)
def test_discount(code, expected):
    assert discount(100, code) == expected


def test_logs():
    logging.getLogger("shop").warning("a warning from the shop")
    assert True


@pytest.mark.skip(reason="not ready")
def test_skipped():
    assert False


@pytest.mark.xfail(reason="known bug")
def test_expected_failure():
    assert discount(10, "HALF") == 6


def test_setup_error(broken_fixture):
    assert True
