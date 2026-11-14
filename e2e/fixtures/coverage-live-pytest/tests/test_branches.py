from pkg.branches import Box, classify, loop, pick, safe, twice


def test_some_branches():
    assert classify(5) == "small items"
    assert classify(-1) == "negative"
    assert pick({"a": 1}) == 1
    assert safe(lambda: 3) == 3
    assert loop([1, 2, 4]) == 6
    assert twice(2) == 4
    assert Box(1).get() == 1
