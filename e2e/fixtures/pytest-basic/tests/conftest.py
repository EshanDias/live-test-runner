import pytest

from shop.cart import Cart


@pytest.fixture
def cart():
    return Cart()


@pytest.fixture
def broken_fixture():
    raise RuntimeError("fixture setup failed on purpose")
