"""Tests of the Live Test Runner pytest plugin (src/framework/pytest/ltr_pytest.py).

Each test writes a small project with pytester and runs pytest in a
subprocess with the plugin loaded exactly as the extension loads it
(``-p ltr_pytest`` with the plugin's folder on PYTHONPATH), then reads the
events and the result file.

    python -m pytest packages/runner/python-tests        (needs pytest; coverage for the coverage tests)
"""

import json
import os
import sys

import pytest

pytest_plugins = ["pytester"]

PLUGIN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "framework", "pytest")


@pytest.fixture
def run(pytester, monkeypatch, tmp_path):
    """Runs pytest with the plugin; returns (events, result, outcome)."""
    monkeypatch.setenv("PYTHONPATH", os.path.abspath(PLUGIN_DIR) + os.pathsep + os.environ.get("PYTHONPATH", ""))
    events_file = tmp_path / "events.jsonl"
    result_file = tmp_path / "result.json"

    def _run(*args, env=None):
        for f in (events_file, result_file):
            if f.exists():
                f.unlink()
        monkeypatch.setenv("LTR_PYTEST_EVENTS", str(events_file))
        for k, v in (env or {}).items():
            monkeypatch.setenv(k, v)
        outcome = pytester.runpytest_subprocess(
            "-p", "ltr_pytest", "--ltr-result=%s" % result_file, "--color=no", "-p", "no:cacheprovider",
            "--continue-on-collection-errors", *args
        )
        events = [json.loads(line) for line in events_file.read_text(encoding="utf-8").splitlines()] if events_file.exists() else []
        result = json.loads(result_file.read_text(encoding="utf-8")) if result_file.exists() else None
        return events, result, outcome

    return _run


def cases(result):
    return {c["fullName"]: c for f in result["fileResults"] for c in f["testCases"]}


def test_statuses_names_and_lines(pytester, run):
    pytester.makepyfile(test_a="""
        import pytest

        @pytest.fixture
        def broken():
            raise RuntimeError("setup boom")

        @pytest.fixture
        def bad_teardown():
            yield
            raise RuntimeError("teardown boom")

        def test_pass():
            pass

        def test_fail():
            assert 1 == 2

        def test_setup_error(broken):
            pass

        def test_teardown_error(bad_teardown):
            pass

        @pytest.mark.skip(reason="not now")
        def test_skip():
            pass

        @pytest.mark.xfail(reason="bug")
        def test_xfail():
            assert False

        @pytest.mark.xfail(strict=True, reason="must fail")
        def test_xpass_strict():
            pass

        class TestK:
            @pytest.mark.parametrize("a", [1, "x y", "ü[1]"])
            def test_p(self, a):
                assert a != "x y"

            class TestInner:
                def test_inner(self):
                    pass
    """)
    events, result, _ = run()
    c = cases(result)
    assert c["test_pass"]["status"] == "passed"
    assert c["test_fail"]["status"] == "failed" and "assert 1 == 2" in c["test_fail"]["failureMessages"][0]
    assert c["test_setup_error"]["status"] == "failed"
    assert c["test_setup_error"]["failureMessages"][0].startswith("Error in setup of test_setup_error:")
    assert c["test_teardown_error"]["status"] == "failed" and "teardown boom" in c["test_teardown_error"]["failureMessages"][0]
    assert c["test_skip"]["status"] == "skipped" and c["test_skip"]["skipReason"] == "not now"
    assert c["test_xfail"]["status"] == "skipped" and c["test_xfail"]["skipReason"] == "xfail: bug"
    assert c["test_xpass_strict"]["status"] == "failed"
    assert c["TestK test_p[1]"]["status"] == "passed"
    assert c["TestK test_p[x y]"]["status"] == "failed"
    assert c["TestK test_p[x y]"]["ancestorTitles"] == ["TestK"] and c["TestK test_p[x y]"]["title"] == "test_p[x y]"
    assert c["TestK TestInner test_inner"]["ancestorTitles"] == ["TestK", "TestInner"]
    # Lines are the 1-based `def` line, also under a decorator.
    src = pytester.path.joinpath("test_a.py").read_text().splitlines()
    def_line = lambda name: next(i + 1 for i, l in enumerate(src) if l.strip().startswith("def %s(" % name))
    assert c["test_pass"]["location"]["line"] == def_line("test_pass")
    assert c["TestK test_p[1]"]["location"]["line"] == def_line("test_p")
    kinds = [e["ev"] for e in events]
    assert kinds[0] == "config" and kinds[-1] == "session-end"
    assert kinds.count("file-start") == 1 and kinds.count("file-end") == 1
    assert kinds.index("file-start") < kinds.index("test-start") < kinds.index("file-end")
    assert result["passed"] is False and result["exitStatus"] == 1


def test_output_is_per_test_and_never_shared(pytester, run):
    pytester.makepyfile(test_out="""
        import logging, sys
        print("at import")

        def test_one():
            print("one says hi")

        def test_two():
            print("two to stderr", file=sys.stderr)
            logging.getLogger("x").warning("two logs")

        def test_quiet():
            pass
    """)
    _, result, _ = run()
    out = result["fileResults"][0]["consoleOutput"]
    by_test = {}
    for e in out:
        by_test.setdefault(e.get("scopeName"), []).append((e["type"], e["message"]))
    assert by_test["test_one"] == [("log", "one says hi")]
    assert ("error", "two to stderr") in by_test["test_two"]
    assert any(kind == "info" and "two logs" in msg for kind, msg in by_test["test_two"])
    assert "test_quiet" not in by_test


def test_unittest_doctest_free_layout_and_collection_errors(pytester, run):
    pytester.makepyfile(
        test_ut="""
            import unittest

            class Things(unittest.TestCase):
                def test_ok(self):
                    self.assertTrue(True)
        """,
        test_broken="import does_not_exist\n\ndef test_never():\n    pass\n",
    )
    pytester.mkpydir("pkg")
    pytester.path.joinpath("pkg", "test_in_pkg.py").write_text("def test_x():\n    pass\n")
    events, result, _ = run()
    files = {os.path.basename(f["testFilePath"]): f for f in result["fileResults"]}
    assert "__init__.py" not in files  # a package is not a test file
    assert files["test_broken.py"]["status"] == "failed" and "does_not_exist" in files["test_broken.py"]["failureMessage"]
    assert files["test_broken.py"]["testCases"] == []
    assert cases(result)["Things test_ok"]["status"] == "passed"
    assert files["test_in_pkg.py"]["status"] == "passed"
    assert len([e for e in events if e["ev"] == "file-end"]) == 3


def test_node_id_selection_runs_exactly_the_named_tests(pytester, run):
    pytester.makepyfile(test_sel="""
        import pytest

        class TestA:
            def test_one(self):
                pass

            @pytest.mark.parametrize("v", ["a b", "c"])
            def test_param(self, v):
                pass

        def test_other():
            pass
    """)
    _, result, _ = run("test_sel.py::TestA::test_param[a b]", "test_sel.py::test_other")
    assert sorted(cases(result)) == ["TestA test_param[a b]", "test_other"]


def test_list_mode_writes_the_collected_files(pytester, run, tmp_path):
    pytester.makepyfile(test_l1="def test_a():\n    pass\n", test_l2="import nope\n")
    listing = tmp_path / "list.json"
    _, result, _ = run("--collect-only", "-q", env={"LTR_PYTEST_LIST": str(listing)})
    data = json.loads(listing.read_text())
    assert sorted(os.path.basename(f) for f in data["files"]) == ["test_l1.py", "test_l2.py"]
    assert [os.path.basename(e["file"]) for e in data["errors"]] == ["test_l2.py"]
    assert data["python_files"] == ["test_*.py", "*_test.py"]


def test_capture_off_is_reported(pytester, run):
    pytester.makepyfile(test_s="def test_a():\n    print('direct')\n")
    events, _, _ = run("-s")
    assert events[0]["ev"] == "config" and events[0]["capture"] == "no"


def test_empty_and_deselected_files_report_no_tests(pytester, run):
    pytester.makepyfile(test_e="import pytest\n\n@pytest.mark.slow\ndef test_a():\n    pass\n")
    _, result, _ = run("-m", "not slow")
    f = result["fileResults"][0]
    assert f["status"] == "passed" and f["testCases"] == []


coverage = pytest.importorskip("coverage", reason="coverage is not installed")


def test_coverage_is_written_istanbul_shaped(pytester, run, tmp_path):
    pytester.makepyfile(
        lib="""
            def pick(x):
                if x:
                    return "yes"
                return "no"

            def unused():
                return 1
        """,
        test_cov="from lib import pick\n\ndef test_pick():\n    assert pick(True) == 'yes'\n",
    )
    pytester.path.joinpath(".coveragerc").write_text("[run]\nbranch = True\n")
    cov_dir = tmp_path / "cov"
    events, _, _ = run(env={"LTR_PYTEST_COVERAGE": str(cov_dir)})
    assert any(e["ev"] == "coverage" for e in events), events
    data = json.loads((cov_dir / "coverage-final.json").read_text())
    lib = next(v for k, v in data.items() if k.endswith("lib.py"))
    lines = {lib["statementMap"][k]["start"]["line"]: lib["s"][k] for k in lib["s"]}
    # def pick (1), if x (2), return "yes" (3) ran; return "no" (4) and unused's body (7) did not.
    assert lines[1] == 1 and lines[2] == 1 and lines[3] == 1
    assert lines[4] == 0 and lines[7] == 0
    # The `if` on line 2: two arms, one taken.
    key = next(k for k, b in lib["branchMap"].items() if b["line"] == 2)
    assert sorted(lib["b"][key]) == [0, 1]
    if tuple(int(p) for p in coverage.__version__.split(".")[:2]) >= (7, 6):
        names = {f["name"]: lib["f"][k] for k, f in lib["fnMap"].items()}
        assert names == {"pick": 1, "unused": 0}
    # Nothing written next to the project.
    assert not (pytester.path / ".coverage").exists()


def test_missing_coverage_package_is_reported_not_fatal(pytester, run, tmp_path):
    pytester.makepyfile(test_nc="def test_a():\n    pass\n")
    # A coverage module that fails to import stands in for "not installed".
    shadow = tmp_path / "shadow"
    shadow.mkdir()
    (shadow / "coverage.py").write_text("raise ImportError('no coverage here')\n")
    events, result, _ = run(env={
        "LTR_PYTEST_COVERAGE": str(tmp_path / "cov2"),
        "PYTHONPATH": str(shadow) + os.pathsep + os.path.abspath(PLUGIN_DIR),
    })
    assert result["passed"] is True
    off = [e for e in events if e["ev"] == "coverage-off"]
    assert off and "not installed" in off[0]["reason"]


def test_each_test_gets_its_own_coverage_context(pytester, run, tmp_path):
    pytester.makepyfile(
        price="def tax(x):\n    return x * 2\n\ndef label(x):\n    return '#' + x\n",
        test_ctx="""
            import price

            class TestP:
                def test_tax(self):
                    assert price.tax(2) == 4

            def test_label():
                assert price.label('a') == '#a'

            def test_nothing():
                assert True
        """,
    )
    cov_dir = tmp_path / "cov3"
    run(env={"LTR_PYTEST_COVERAGE": str(cov_dir)})
    records = [json.loads(l) for l in (cov_dir / "trace.jsonl").read_text().splitlines()]
    tests = {r["tn"]: r for r in records if r["type"] == "T"}
    src = lambda r: {os.path.basename(f): ls for f, ls in r["fh"].items()}
    assert src(tests["TestP test_tax"])["price.py"] == [2]
    assert src(tests["test_label"])["price.py"] == [5]
    assert "price.py" not in src(tests.get("test_nothing", {"fh": {}}))
    assert all(r["tf"].endswith("test_ctx.py") for r in tests.values())
    # Lines run at import (the defs) are outside every test: coverage only.
    outside = [r for r in records if r["type"] == "H"]
    assert outside and outside[0]["hk"] == "file" and {1, 4} <= set(src(outside[0])["price.py"])


@pytest.mark.skipif(sys.version_info >= (3, 14), reason="sysmon records contexts from Python 3.14")
def test_a_core_without_contexts_turns_covering_tests_off_not_the_run(pytester, run, tmp_path):
    # The project (here: the environment) chose coverage's sysmon core, which records no
    # per-test contexts before 3.14: tests and coverage still work, covering tests are off.
    pytester.makepyfile(m="def f():\n    return 1\n", test_m="from m import f\n\ndef test_f():\n    assert f() == 1\n")
    cov_dir = tmp_path / "cov4"
    events, result, outcome = run(env={"LTR_PYTEST_COVERAGE": str(cov_dir), "COVERAGE_CORE": "sysmon"})
    assert result["passed"] is True
    assert any(e["ev"] == "coverage" for e in events)
    assert "covering tests are off" in outcome.stderr.str()
    trace = cov_dir / "trace.jsonl"
    assert not trace.exists() or not any(json.loads(l)["type"] == "T" for l in trace.read_text().splitlines())
