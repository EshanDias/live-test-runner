from shop.price import discount, total


def test_total():
    assert total([1, 2, 3]) == 6


def test_discount():
    assert discount(100, 10) == 90


def test_fails_on_purpose():
    assert total([]) == 1
