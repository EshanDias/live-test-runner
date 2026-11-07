from app.users import display_name


def test_display_name():
    assert display_name("Ada", "Lovelace") == "Ada Lovelace"


def test_only_first():
    assert display_name("Ada", "") == "Ada"
