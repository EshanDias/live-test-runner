import sys
from pathlib import Path

from jobs import double


def test_runs_with_the_services_own_venv():
    assert Path(sys.prefix).resolve() == (Path(__file__).parents[1] / ".venv").resolve()


def test_double():
    assert double(2) == 4


def test_double_broken():
    assert double(3) == 7
