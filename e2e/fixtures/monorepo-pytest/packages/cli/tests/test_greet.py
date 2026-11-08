import pytest

from ws_cli.greet import greet


def test_greet():
    assert greet("Ada") == "Hello, Ada"


@pytest.mark.parametrize("name", ["Bob", "Cy"])
def test_greet_many(name):
    assert greet(name).endswith(name)
