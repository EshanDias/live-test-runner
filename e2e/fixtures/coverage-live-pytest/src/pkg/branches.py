# Branch-heavy code, partly tested (test_branches): every construct coverage.py counts.
import os


def classify(n, unit=None):
    if n < 0:
        return "negative"
    elif n == 0:
        return "zero"
    label = "big" if n > 100 else "small"
    return label + " " + (unit or "items")


def pick(d):
    return d.get("a") or d.get("c")


def safe(fn):
    try:
        return fn()
    except Exception:
        return "failed"


def loop(xs):
    total = 0
    for x in xs:
        if x % 2:
            continue
        total += x
    while total > 100:
        total -= 100
    return total


class Box:
    def __init__(self, v):
        self.v = v

    def get(self):
        return self.v

    def unused(self):
        return self.v + 1


twice = lambda x: x * 2  # noqa: E731

MODE = "never" if os.environ.get("LTR_NEVER_SET") else "dev"
