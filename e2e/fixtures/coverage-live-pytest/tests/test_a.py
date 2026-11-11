from pkg.a import one, two


def test_one():
    assert one(1) == 2


def test_two():
    assert two(2) == 4


# Uses nothing from a.py: saving a.py reruns test_one by node id only.
def test_unrelated():
    assert len([1, 2]) == 2
