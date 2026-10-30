import unittest

from shop.cart import discount


class DiscountTests(unittest.TestCase):
    def test_half(self):
        self.assertEqual(discount(8, "HALF"), 4)

    def test_tenoff_floor(self):
        self.assertEqual(discount(5, "TENOFF"), 0)
