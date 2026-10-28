"""Live Test Runner -- pytest plugin.

Shipped inside the VS Code extension and loaded only by the extension's own
command line (``python -m pytest -p ltr_pytest ...`` with this file's folder
on PYTHONPATH). Nothing is installed into the project or its environment, and
a plain ``pytest`` in the user's terminal never sees this plugin.

What it does (every output goes to files in the extension's session folder):

* ``$LTR_PYTEST_EVENTS``: one JSON object per line while the run goes --
  ``file-start``, ``test-start``, ``test-end``, ``file-end`` (the file's result),
  ``config``, ``session-end``. The extension reads them live.
* ``--ltr-result=<file>``: the whole run's result (a RunResult) at the end.
* ``$LTR_PYTEST_LIST``: with ``--collect-only``, the collected test files.
* ``$LTR_PYTEST_COVERAGE=<dir>``: measures coverage with the project's own
  coverage.py and its own settings, and writes it istanbul-shaped to
  ``<dir>/coverage-final.json`` (data files stay in ``<dir>``). Each test is
  measured in its own coverage context (its node id), written as the
  extension's trace records to ``<dir>/trace.jsonl``: which lines each test
  ran ("covering tests", precise reruns when a source file is saved).

Result shapes mirror the runner's TypeScript types (FileRunResult,
TestCaseRunResult, ConsoleEntry). Logs: ``[LTR:<level>] message`` on stderr.

Keep it compatible with every pytest >= 7.0 and plain Python syntax (no
``match``), and never import anything from the project.
"""

import json
import os
import sys
import time

import pytest

EVENTS_ENV = "LTR_PYTEST_EVENTS"
LIST_ENV = "LTR_PYTEST_LIST"
COVERAGE_ENV = "LTR_PYTEST_COVERAGE"

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_CWD = os.getcwd()

# One pytest session per process (inner sessions of pytester never load this
# plugin: it is named only with -p on our own command line).
_config = None
_events = None
_cov = None
_cov_error = None
_contexts = True  # per-test contexts (off when the project's coverage config sets its own dynamic_context)
_pending_logs = []  # (level, message) from before pytest_configure: output capture swallows them there
_nodes = {}  # nodeid -> {"file", "titles", "name", "line"}
_files = {}  # file -> _FileState
_tests = {}  # nodeid -> {"reports": {when: report}}
_collected_files = []
_collect_errors = []


class _FileState(object):
    def __init__(self, path):
        self.path = path
        self.started = False
        self.finished = False
        self.remaining = set()
        self.cases = []
        self.output = []
        self.failure = None
        self.started_at = None
        self.result = None


# -- output ---------------------------------------------------------------------


def _emit(**record):
    global _events
    target = os.environ.get(EVENTS_ENV)
    if not target:
        return
    try:
        if _events is None:
            _events = open(target, "a", encoding="utf-8")
        _events.write(json.dumps(record, default=str) + "\n")
        _events.flush()
    except Exception:  # never break the user's run over our bookkeeping
        pass


def _log(level, message):
    """A structured log line for the extension, past pytest's output capture."""
    if _config is None:
        _pending_logs.append((level, message))  # written in pytest_configure
        return
    line = "[LTR:%s] %s\n" % (level, message)
    capman = _config.pluginmanager.getplugin("capturemanager") if _config else None
    try:
        if capman is not None:
            with capman.global_and_fixture_disabled():
                sys.stderr.write(line)
                sys.stderr.flush()
        else:
            sys.stderr.write(line)
    except Exception:
        pass


# -- options and setup ------------------------------------------------------------


def pytest_addoption(parser):
    group = parser.getgroup("live-test-runner")
    group.addoption("--ltr-result", dest="ltr_result", default=None, help="(Live Test Runner) write the run's result here")


@pytest.hookimpl(tryfirst=True)
def pytest_load_initial_conftests(early_config, parser, args):
    # The moment pytest-cov starts measuring: conftest.py and package
    # __init__ imports count as covered.
    _start_coverage(early_config)


def pytest_configure(config):
    global _config
    _config = config
    _start_coverage(config)
    for level, message in _pending_logs:
        _log(level, message)
    del _pending_logs[:]
    _emit(
        ev="config",
        capture=_option(config, "capture"),
        rootdir=str(config.rootpath),
        inifile=str(config.inipath) if config.inipath else None,
        pytest=pytest.__version__,
        python=sys.version.split()[0],
        coverage=_cov is not None,
        coverageError=_cov_error,
    )
    if _option(config, "capture") == "no":
        _log("debug", "output capturing is off (-s / --capture=no): test output goes to the process output, not to each test")


def _option(config, name):
    try:
        return config.getoption(name)
    except Exception:
        return None


# -- coverage ------------------------------------------------------------------------


def _start_coverage(config):
    global _cov, _cov_error
    directory = os.environ.get(COVERAGE_ENV)
    if not directory or _cov is not None or _cov_error is not None:
        return
    try:
        import coverage
    except ImportError:
        _cov_error = "the coverage package is not installed in this Python environment"
        return
    try:
        os.makedirs(directory, exist_ok=True)
        kwargs = {"data_file": os.path.join(directory, ".coverage"), "config_file": True}
        # pytest-cov's --cov=<src> (from the project's addopts) names what to
        # measure; our command line adds --no-cov, so pytest-cov itself is idle.
        sources = _cov_sources(config)
        if sources:
            kwargs["source"] = sources
        _cov = coverage.Coverage(**kwargs)
        _choose_core(_cov)
        _cov.start()
        _check_contexts(_cov)
    except Exception as err:  # a broken coverage config must not stop the tests
        _cov = None
        _cov_error = "coverage could not start: %s" % err


def _choose_core(cov):
    """A coverage core that records per-test contexts, unless the project picked one.

    coverage.py's ``sysmon`` core records no dynamic contexts before Python 3.14
    (it warns and puts every line in one context); it is chosen when the compiled
    tracer is missing (e.g. Windows wheels without it). Prefer ``ctrace``, else
    ``pytrace`` below 3.14. Only for this process: the project's settings and
    the user's own runs are untouched.
    """
    if os.environ.get("COVERAGE_CORE") or getattr(cov.config, "core", None):
        return
    try:
        import coverage.tracer  # noqa: F401  (the compiled CTracer)
        core = "ctrace"
    except ImportError:
        core = None if sys.version_info >= (3, 14) else "pytrace"
    if core is None:
        return
    try:
        cov.config.set_option("run:core", core)
    except Exception:  # coverage before the [run] core option: the environment variable it reads
        os.environ["COVERAGE_CORE"] = core


def _check_contexts(cov):
    global _contexts
    core = getattr(cov, "_core", None)
    if core is not None and getattr(core, "supports_dynamic_contexts", True) is False:
        _contexts = False
        _log("info", "covering tests are off for this run: coverage.py's %s core records no per-test contexts"
             % type(core).__name__)


def _cov_sources(config):
    ns = getattr(config, "known_args_namespace", None) or getattr(config, "option", None)
    values = getattr(ns, "cov_source", None) or []
    return [v for v in values if isinstance(v, str) and v]


def _finish_coverage():
    """Stops coverage and writes coverage-final.json; returns its path or None."""
    if _cov is None:
        return None
    directory = os.environ.get(COVERAGE_ENV)
    try:
        _cov.stop()
        _cov.save()
        raw = os.path.join(directory, "coverage.json")
        try:
            _cov.json_report(outfile=raw)
        except Exception as err:  # NoDataError: nothing under the project ran
            _log("debug", "no coverage data: %s" % err)
            return None
        with open(raw, encoding="utf-8") as fh:
            report = json.load(fh)
        out = os.path.join(directory, "coverage-final.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(_istanbul(report), fh)
        if _contexts:
            _write_trace(os.path.join(directory, "trace.jsonl"))
        return out
    except Exception as err:
        _log("warn", "could not write coverage: %s" % err)
        return None


def _write_trace(target):
    """Per-test coverage contexts as the extension's trace records (traceRecords.ts):

    ``T`` {tf: test file, tn: full name, fh: {source: [lines]}} for each test,
    ``H`` {tf, hk: "file", fh} for lines run outside any test (imports, collection).
    Read straight from the coverage data — coverage's own JSON report with
    contexts is far too large (ADR-9: 1.2 GB on httpx).
    """
    data = _cov.get_data()
    per_test = {}  # nodeid -> {source: [lines]}
    outside = {}
    for measured in data.measured_files():
        path = os.path.normpath(measured)
        if not _keep_coverage_file(path):
            continue
        try:
            by_line = data.contexts_by_lineno(measured)
        except Exception:
            continue
        for line, labels in by_line.items():
            for label in labels:
                bucket = per_test.setdefault(label, {}) if label else outside
                bucket.setdefault(path, []).append(line)
    unknown = [label for label in per_test if label not in _nodes]
    try:
        recorded = len(data.measured_contexts())
    except Exception:
        recorded = -1
    core = getattr(_cov, "_core", None)
    _log("debug", "covering tests: %d measured file(s), %d test context(s), %d recorded context(s), %d switch(es)%s, core %s%s" % (
        len(data.measured_files()), len(per_test) - len(unknown), recorded, _switches["ok"],
        (", switch error %s" % _switches["error"]) if _switches["error"] else "",
        type(core).__name__ if core is not None else "?",
        (", %d unknown label(s) e.g. %r" % (len(unknown), unknown[0])) if unknown else ""))
    with open(target, "w", encoding="utf-8") as fh:
        for nodeid, hits in per_test.items():
            node = _nodes.get(nodeid)
            if node is None:
                continue
            record = {"type": "T", "tf": node["file"], "tn": " ".join(node["titles"] + [node["name"]]), "fh": {f: sorted(set(ls)) for f, ls in hits.items()}}
            fh.write(json.dumps(record) + "\n")
        if outside:
            for test_file in sorted({n["file"] for n in _nodes.values()}):
                fh.write(json.dumps({"type": "H", "tf": test_file, "hk": "file", "fh": {f: sorted(set(ls)) for f, ls in outside.items()}}) + "\n")
                break  # coverage only: one record is enough


def _keep_coverage_file(path):
    """A measured file under the project (the rootdir or the cwd), never our plugin.

    Compared through real paths, case-normalised: coverage.py names files by
    their canonical path (Windows: long names, lower case) while the rootdir
    keeps the spelling it was started with (8.3 short names, as on GitHub's
    Windows runners).
    """
    norm = lambda p: os.path.normcase(os.path.realpath(p))
    target = norm(path)
    if target.startswith(norm(_PLUGIN_DIR) + os.sep):
        return False
    root = str(_config.rootpath) if _config else _CWD
    for base in {norm(root), norm(_CWD)}:
        if target.startswith(base.rstrip(os.sep) + os.sep):
            return True
    return False


def _istanbul(report):
    """coverage.py's JSON report -> an istanbul coverage map (0/1 counters).

    Statements: one per measured line. Branches: the arcs leaving a line,
    one arm per destination (negative = leaves the function). Functions:
    coverage >= 7.6 regions (skipped before).
    """
    out = {}
    for name, f in (report.get("files") or {}).items():
        path = os.path.normpath(os.path.join(_CWD, name))
        if not _keep_coverage_file(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read().split("\n")
        except OSError:
            text = []

        def width(line):
            return len(text[line - 1]) if 0 < line <= len(text) else 0

        executed = set(f.get("executed_lines") or [])
        lines = sorted(executed | set(f.get("missing_lines") or []))
        statement_map, s = {}, {}
        for i, line in enumerate(lines):
            key = str(i)
            statement_map[key] = {"start": {"line": line, "column": 0}, "end": {"line": line, "column": width(line)}}
            s[key] = 1 if line in executed else 0

        branch_map, b = {}, {}
        arcs = {}
        for arc in f.get("executed_branches") or []:
            arcs.setdefault(arc[0], []).append((arc[1], 1))
        for arc in f.get("missing_branches") or []:
            arcs.setdefault(arc[0], []).append((arc[1], 0))
        for i, start in enumerate(sorted(a for a in arcs if a > 0)):
            arms = sorted(arcs[start], key=lambda arm: (arm[0] < 0, abs(arm[0])))
            branch_map[str(i)] = {
                "type": "branch",
                "line": start,
                "loc": {"start": {"line": start, "column": 0}, "end": {"line": start, "column": width(start)}},
                "locations": [
                    {"start": {"line": abs(to) if to > 0 else start, "column": 0}, "end": {"line": abs(to) if to > 0 else start, "column": 0}}
                    for to, _ in arms
                ],
            }
            b[str(i)] = [hit for _, hit in arms]

        fn_map, fn = {}, {}
        for i, (fname, region) in enumerate(sorted((f.get("functions") or {}).items())):
            if not fname:
                continue  # the module itself
            region_lines = sorted(set(region.get("executed_lines") or []) | set(region.get("missing_lines") or []))
            if not region_lines:
                continue
            first = region.get("start_line") or region_lines[0]
            key = str(len(fn_map))
            fn_map[key] = {
                "name": fname,
                "line": first,
                "decl": {"start": {"line": first, "column": 0}, "end": {"line": first, "column": width(first)}},
                "loc": {"start": {"line": first, "column": 0}, "end": {"line": region_lines[-1], "column": width(region_lines[-1])}},
            }
            fn[key] = 1 if region.get("executed_lines") else 0

        out[path] = {"path": path, "statementMap": statement_map, "s": s, "branchMap": branch_map, "b": b, "fnMap": fn_map, "f": fn}
    return out


# -- collection ----------------------------------------------------------------------


def _file_of(nodeid):
    part = nodeid.split("::", 1)[0]
    root = str(_config.rootpath) if _config else _CWD
    return os.path.normpath(os.path.join(root, part))


def _state(path):
    st = _files.get(path)
    if st is None:
        st = _files[path] = _FileState(path)
    return st


def pytest_collectreport(report):
    if not report.nodeid:
        return
    part = report.nodeid.split("::", 1)[0]
    # Modules only: a package's own collector (pytest 7 names it ".../__init__.py") is not a test file.
    if not part.endswith(".py") or (part.rsplit("/", 1)[-1] == "__init__.py" and "::" not in report.nodeid and not report.failed):
        return
    path = _file_of(report.nodeid)
    st = _state(path)
    if path not in _collected_files:
        _collected_files.append(path)
    if report.failed:
        message = _longrepr(report) or "collection failed"
        st.failure = message if st.failure is None else st.failure + "\n\n" + message
        _collect_errors.append({"file": path, "message": message})
    for title, content in getattr(report, "sections", None) or []:
        if content.strip():
            st.output.append(_entry(title, content, "file", None))


def pytest_collection_finish(session):
    for item in session.items:
        path = os.path.normpath(str(item.path))
        titles = [n.name for n in item.listchain() if isinstance(n, pytest.Class)]
        location = getattr(item, "location", None) or (None, None, None)
        line = location[1] + 1 if isinstance(location[1], int) else None
        if line is not None:
            line = _def_line(path, line, getattr(item, "originalname", None) or item.name.split("[", 1)[0])
        _nodes[item.nodeid] = {"file": path, "titles": titles, "name": item.name, "line": line}
        _state(path).remaining.add(item.nodeid)
        if path not in _collected_files:
            _collected_files.append(path)

    listing = os.environ.get(LIST_ENV)
    if listing:
        try:
            with open(listing, "w", encoding="utf-8") as fh:
                json.dump({
                    "files": _collected_files,
                    "errors": _collect_errors,
                    "rootdir": str(session.config.rootpath),
                    "inifile": str(session.config.inipath) if session.config.inipath else None,
                    "python_files": session.config.getini("python_files"),
                    "testpaths": session.config.getini("testpaths"),
                }, fh)
        except Exception as err:
            _log("warn", "could not write the test list: %s" % err)

    if _option(session.config, "collectonly"):
        return
    # Files without a test to run (all deselected, empty, skipped at module
    # level, or failed to import) are done now.
    for path in list(_collected_files):
        st = _state(path)
        if not st.remaining and not st.started:
            _start_file(st)
            _finish_file(st)


# -- running -------------------------------------------------------------------------------


def _start_file(st):
    if st.started:
        return
    st.started = True
    st.started_at = time.time()
    _emit(ev="file-start", file=st.path)


_switches = {"ok": 0, "error": None}


def _switch_context(label):
    global _contexts
    if _cov is None or not _contexts:
        return
    try:
        _cov.switch_context(label)
        _switches["ok"] += 1
    except Exception as err:  # e.g. the project's own [run] dynamic_context
        _contexts = False
        _switches["error"] = "%s: %s" % (type(err).__name__, err)
        _log("info", "covering tests are off for this run: coverage.py refused per-test contexts (%s)" % err)


def pytest_runtest_logstart(nodeid, location):
    _switch_context(nodeid)
    node = _nodes.get(nodeid)
    path = node["file"] if node else _file_of(nodeid)
    _start_file(_state(path))
    _tests[nodeid] = {"reports": {}}
    _emit(ev="test-start", file=path, nodeid=nodeid, name=node["name"] if node else nodeid)


def pytest_runtest_logreport(report):
    if report.when not in ("setup", "call", "teardown"):
        return
    test = _tests.setdefault(report.nodeid, {"reports": {}})
    test["reports"][report.when] = report


def pytest_runtest_logfinish(nodeid, location):
    _switch_context("")
    node = _nodes.get(nodeid) or {"file": _file_of(nodeid), "titles": [], "name": nodeid.split("::")[-1], "line": None}
    reports = (_tests.pop(nodeid, None) or {"reports": {}})["reports"]
    case, output = _case(node, reports)
    st = _state(node["file"])
    st.cases.append(case)
    st.output.extend(output)
    st.remaining.discard(nodeid)
    _emit(ev="test-end", file=node["file"], nodeid=nodeid, status=case["status"])
    if not st.remaining:
        _finish_file(st)


def _case(node, reports):
    titles, name = node["titles"], node["name"]
    full_name = " ".join(titles + [name])
    status, messages = "passed", []
    for when in ("setup", "call", "teardown"):
        r = reports.get(when)
        if r is None:
            continue
        if r.failed:
            status = "failed"
            text = _longrepr(r)
            messages.append(text if when == "call" else "Error in %s of %s:\n%s" % (when, name, text))
        elif r.skipped and status != "failed":
            status = "skipped"
            reason = getattr(r, "wasxfail", None)
            if reason is not None:
                messages.append("xfail" + (": %s" % reason if reason else ""))
            else:
                text = _skip_reason(r)
                if text:
                    messages.append(text)
    call = reports.get("call")
    durations = [r.duration for r in reports.values() if getattr(r, "duration", None) is not None]
    duration = call.duration if call is not None else sum(durations)
    case = {
        "ancestorTitles": titles,
        "title": name,
        "fullName": full_name,
        "status": status,
        "duration": round(duration * 1000, 3),
        "failureMessages": messages if status == "failed" else [],
    }
    if status == "skipped" and messages:
        case["skipReason"] = messages[0]
    if node.get("line"):
        case["location"] = {"line": node["line"], "column": 1}
    # The last phase report holds every phase's captured sections.
    last = reports.get("teardown") or reports.get("call") or reports.get("setup")
    output = []
    seen = set()
    for title, content in (getattr(last, "sections", None) or []):
        if title in seen or not content.strip():
            continue
        seen.add(title)
        output.append(_entry(title, content, "test", full_name))
    return case, output


def _finish_file(st):
    if st.finished:
        return
    st.finished = True
    failed = st.failure is not None or any(c["status"] == "failed" for c in st.cases)
    st.result = {
        "testFilePath": st.path,
        "status": "failed" if failed else "passed",
        "testCases": st.cases,
        "consoleOutput": st.output,
        "duration": round((time.time() - (st.started_at or time.time())) * 1000, 3),
    }
    if st.failure is not None:
        st.result["failureMessage"] = st.failure
    _emit(ev="file-end", file=st.path, result=st.result)


def pytest_sessionfinish(session, exitstatus):
    if _option(session.config, "collectonly"):
        _finish_coverage()
        return
    # Interrupted (-x, maxfail, Ctrl+C): files that started report what ran.
    for st in list(_files.values()):
        if st.started and not st.finished:
            _finish_file(st)
    coverage_file = _finish_coverage()
    if coverage_file:
        _emit(ev="coverage", file=coverage_file)
    elif _cov_error:
        _emit(ev="coverage-off", reason=_cov_error)
    status = int(exitstatus)
    _write_result(session.config, status)
    _emit(ev="session-end", exit=status)


def _write_result(config, status):
    target = _option(config, "ltr_result")
    if not target:
        return
    results = [st.result for st in _files.values() if st.finished]
    cases = [c for r in results for c in r["testCases"]]
    run = {
        # 5 = no tests collected: nothing failed.
        "passed": status in (0, 5),
        "numPassedTests": sum(1 for c in cases if c["status"] == "passed"),
        "numFailedTests": sum(1 for c in cases if c["status"] == "failed"),
        "numPendingTests": sum(1 for c in cases if c["status"] == "skipped"),
        "fileResults": results,
        "errors": [e["message"] for e in _collect_errors],
        "exitStatus": status,
    }
    try:
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(run, fh, default=str)
    except Exception as err:
        _log("error", "could not write the result file: %s" % err)


# -- helpers -------------------------------------------------------------------------------

_DEF_RE = None


def _def_line(path, line, name):
    """The `def` line of a test pytest locates at its first decorator."""
    global _DEF_RE
    import linecache
    import re
    if _DEF_RE is None:
        _DEF_RE = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)")
    for n in range(line, line + 60):
        text = linecache.getline(path, n)
        if not text:
            break
        m = _DEF_RE.match(text)
        if m:
            return n if m.group(1) == name else line
        stripped = text.strip()
        if stripped and not stripped.startswith(("@", "#", ")", "]", "}", ",")) and n == line:
            return line  # not a decorator: the location is the def itself (or a class / doctest)
    return line


def _longrepr(report):
    try:
        text = report.longreprtext
    except Exception:
        text = str(getattr(report, "longrepr", "") or "")
    return text.strip("\n")


def _skip_reason(report):
    longrepr = getattr(report, "longrepr", None)
    if isinstance(longrepr, tuple) and len(longrepr) == 3:
        reason = str(longrepr[2])
        return reason[len("Skipped: "):] if reason.startswith("Skipped: ") else reason
    return None


def _entry(title, content, scope, scope_name):
    """A captured section ("Captured stdout call") as a ConsoleEntry."""
    kind = "log"
    if "stderr" in title:
        kind = "error"
    elif " log " in (" %s " % title):
        kind = "info"
    entry = {"message": content.rstrip("\n"), "type": kind, "origin": title, "scope": scope}
    if scope_name is not None:
        entry["scopeName"] = scope_name
    return entry
