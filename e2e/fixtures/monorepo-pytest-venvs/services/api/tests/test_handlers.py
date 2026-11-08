import sys
from pathlib import Path

from api_app.handlers import echo, health


def test_runs_with_the_services_own_venv():
    assert Path(sys.prefix).resolve() == (Path(__file__).parents[1] / ".venv").resolve()


def test_health():
    assert health() == {"status": "ok"}


def test_echo():
    assert echo("hi") == {"echo": "hi"}
