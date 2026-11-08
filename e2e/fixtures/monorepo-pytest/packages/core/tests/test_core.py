from ws_core import add, halve


def test_add():
    assert add(2, 3) == 5


def test_halve():
    assert halve(8) == 4


def test_fails_on_purpose():
    assert add(1, 1) == 3
