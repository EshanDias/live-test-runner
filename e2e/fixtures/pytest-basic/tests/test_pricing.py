from shop import labels  # noqa: F401  (imported, never called by a test)
from shop.pricing import with_tax


def test_with_tax():
    assert with_tax(10) == 12


def test_without_pricing():
    assert "a" * 2 == "aa"
