# pytest Support & Language Decoupling — Task Plan (draft for release 3.4.0)

> Working document, same format as `docs/temp_plans/vitest-support-plan.md`.
> Work tasks top to bottom and tick the box in the [Progress tracker](#progress-tracker)
> when one is done. Estimates are *focused working days including tests and docs*, ±30 %.
> Written 2026-10-23 against `feat/mixed-frameworks` @ `ff83b27` (3.1.0 unreleased:
> phases 7 + 8 of the Vitest plan done; Vitest trace phase 9 still open).

## 0. Decisions

Rows marked **open** need an answer from the owner. Each has a recommendation; the plan
below assumes the recommendation.

| # | Decision | Status |
|---|---|---|
| D1 | pytest work starts after 3.1.0 ships. `release/3.4.0` is cut from `main`; one `feat/pytest-<phase>` branch per phase, chained on the previous one; each branch is committed and pushed, **the agent opens no PRs** (same as Vitest D9). | proposed (matches the memory rule) |
| D2 | **Baseline versions:** pytest **≥ 7.0** (results, node ids and the `-p` plugin hooks we use are stable since 7), Python **≥ 3.8** for the plugin code (no `match`, no 3.10+ syntax). Tested matrix: pytest 7.4, 8.4, 9.1 (current: 9.1.1, 2026-06-19) × Python 3.9, 3.12, 3.14. Older pytest → "not supported" message, no best-effort mode. | **open** — recommend as written |
| D3 | **First release (3.4.0) = one Python project:** run, pass/fail, per-test output, failures with diffs, live per-test progress, hang limit, ▶ Run / ▷ Debug one test or class, rerun a saved test file, coverage (gutter + hover). | **open** — recommend including Debug (2 d, makes the CodeLens row complete) |
| D4 | **3.5.0** = "covering tests" in the hover + precise source-file on-save reruns, both from coverage.py **dynamic contexts** (one context per test, written by our plugin) — no tracer of our own. Fallback before the first coverage run: static import graph → whole test files. | **open** — recommend |
| D5 | **3.6.0** = Python monorepos (one project per pytest root) and **JS + Python in the same folder**. | **open** — recommend |
| D6 | **Timeline debugger for pytest: out of scope** (needs a `sys.settrace` / `sys.monitoring` step recorder + variable capture; the Jest timeline is not where the owner wants it either, Vitest D9). Matrix cell "—, later". | **open** — recommend |
| D7 | **Python interpreter:** order = `liveTestRunner.pythonPath` setting → the Python extension's active environment for the project folder (`@vscode/python-extension`, `PythonExtension.api().environments`, an *optional* integration, not an `extensionDependency`) → `VIRTUAL_ENV` → `.venv` / `venv` / `env` in the project root or workspace folder (uv and `python -m venv` default to `.venv`) → `poetry env info -p` when `poetry.lock` exists → `python3` / `python` on PATH (Windows: `py -3`). The chosen interpreter is probed once (`python -c …` → JSON of versions) and shown in the log. | **open** — recommend |
| D8 | **Never install packages for the user.** Missing pytest → error naming the interpreter and the two fixes ("select the project's environment", "`pip install pytest`"). Missing `coverage` → tests run, coverage shows an actionable "install `coverage`" message (like the missing Vitest provider). | proposed |
| D9 | **Results come from our own pytest plugin** (`ltr_pytest.py`, loaded with `-p ltr_pytest` from the session folder on `PYTHONPATH`) streaming JSON lines per event — not JUnit XML (no live events, no per-phase output, no locations) and not `pytest-json-report` (an install). | proposed |
| D10 | **Test identity:** a pytest test's `fullName` = its classes + function name + parametrize id, space-joined (`TestCart test_total[2-items]`), exactly like Jest/Vitest ancestors + title. The runner turns names back into **node ids** (`<abs file>::TestCart::test_total[2-items]`) — never `-k`, which matches substrings and keywords. | proposed |
| D11 | **Coverage via coverage.py driven by our plugin** (`coverage.Coverage` API, the project's own `[coverage:run]` / `[tool.coverage]` settings, data file in the session folder). pytest-cov is **not** required; when it is installed we pass `--no-cov` for our runs so two tracers never run at once, and reuse its `--cov=<source>` values as `source`. | **open** — recommend |
| D12 | **Static discovery** (CodeLens / gutter before a run): a TypeScript indentation-aware line scanner (`def test*` / `async def test*` / `class Test*` / `unittest.TestCase` subclasses, honouring `python_files` / `python_classes` / `python_functions`), no interpreter needed, synchronous. `@pytest.mark.parametrize` functions become template nodes (`test_x[…]`). Rejected: tree-sitter wasm (≈ 1 MB+ per grammar, async init), a Python `ast` helper process (needs a working interpreter before anything shows; slower cold start). | **open** — recommend the scanner; the `ast` helper stays a fallback if the scanner proves too weak on real repos |
| D13 | **Same folder, JS + Python** (Django + React, Streamlit …): **one project**, files routed by language (`.py` → pytest bundle, everything else → the existing Jest/Vitest router). One Start runs both; status bar `Jest 12 · pytest 30`; Explorer groups by framework (reuses D12/ADR-8 grouping). Different folders → separate projects, as phase 7 does. Rejected: two switcher entries at the same root (breaks `ProjectContext.id = root`, two Starts for one repo). | **open** — recommend |
| D14 | **xdist:** respected. If the project's `addopts` contain `-n …`, our runs keep it; the plugin works on the controller (results) *and* in workers (coverage: one data file per worker, merged by the extension). Hang detection uses per-test heartbeats from the controller. Scoped single-test reruns add `-n 0` (valid when xdist is loaded; `-p no:xdist` would make an `addopts` `-n` an unknown flag) to skip worker start-up for one test. | **open** — recommend |
| D15 | **Keep the user's repo clean:** `-o cache_dir=<session>/pytest-cache` (our partial runs never rewrite the user's `--lf` state), coverage data file in the session folder. `.pyc` files are left to Python (setting `PYTHONPYCACHEPREFIX` would recompile every session). | proposed |
| D16 | **New settings:** `liveTestRunner.pythonPath` (string, '' = auto, D7), `liveTestRunner.pytestArgs` (string[] appended to every run). No `pytestCommand` override in 3.4 (a `uv run` / `poetry run` wrapper is covered by D7's interpreter resolution); revisit if users ask. | **open** — recommend |
| D17 | Real Python repos for the regression gate live in `/Users/eshandias/Projects/test/python-projects` (read-only, like the Jest/Vitest ones), each with its own `.venv` prepared once by the owner (§4). | **open** — confirm folder + repos (§4) |

### Release roadmap

| Release | Scope | Phases |
|---|---|---|
| **3.4.0** | Decouple from JavaScript + pytest single project: run, pass/fail, per-test output, failures, live progress, hang limit, rerun a saved test file, Debug, coverage; feature matrix | 0, 1, 2, 3, 4, 5, 9 (part) |
| 3.5.0 | Covering tests + precise source-file on-save reruns (coverage contexts), import-graph fallback | 6 |
| 3.6.0 | Python monorepos + JS and Python in one folder | 7, 8 |
| later | Timeline debugger for pytest (D6) | — |

### Feature matrix — planned pytest column

One row per `docs/framework-features.md` row (plus one new row). Cells use the matrix legend.

| Feature | pytest (planned cell) | Release | Notes |
|---|---|---|---|
| Run & pass/fail | ⏳ 3.4 | 3.4.0 | `python -m pytest` with our plugin; xfail → skipped, strict xpass → failed, setup/teardown errors → failed with the phase named |
| ▶ Run / ▷ Debug one test or suite | ⏳ 3.4 (Debug needs the Python Debugger extension) | 3.4.0 | node ids; suite = class; parametrized function = all its cases; debug = `debugpy` launch, `module: pytest` |
| Rerun a saved test file | ⏳ 3.4 | 3.4.0 | `*.py` saves pass the on-save filter (1.2) |
| Logs / console output | ⏳ 3.4 **per test** | 3.4.0 | captured stdout / stderr / logging per phase (`report.sections`) — attribution like Vitest; `-s` in `addopts` → file-level only + one WARN |
| Coverage (gutter, hover) | ⏳ 3.4 needs `coverage` (pytest-cov not needed) | 3.4.0 | lines + branches (arcs) + functions (coverage ≥ 7.6) |
| Live per-file progress | ⏳ 3.4 (per test) | 3.4.0 | plugin events `file-start` / `test-start` / `test-end` / `file-end` |
| Rerun tests related to a saved source file | ⏳ 3.5 per test (coverage contexts); whole files by import graph before the first coverage run | 3.5.0 | |
| Monorepo / multi-project (project switcher) | ⏳ 3.6 one project per pytest root (`pytest.ini` / `pyproject.toml` / `setup.cfg` / `tox.ini` / root `conftest.py`) | 3.6.0 | uv workspaces: one project per member with tests |
| Mixed Jest + Vitest in one project | — | — | |
| **Mixed JS + Python in one folder** (new row) | ⏳ 3.6 | 3.6.0 | Jest/CRA/Vitest cells: ⏳ 3.6 too (same feature) |
| Execution trace / "covering tests" | ⏳ 3.5 from coverage contexts (which tests ran a line; no step trace) | 3.5.0 | |
| Timeline debugger | — later | — | D6 |

---

## 1. Goals

1. Remove the remaining **JavaScript assumptions** (file extensions, Babel discovery, name
   regexes as test identity, node-only binary resolution, package.json-only project
   detection, a two-framework router) so a non-JS framework plugs in through the existing
   interfaces — `SessionManager`, stores, views and observers stay untouched apart from the
   decoupling tasks in phase 1.
2. Add **pytest** with the same behaviour users know from Jest/Vitest, delivered as visible
   features: run + pass/fail → output → live progress → coverage → debug → covering tests /
   related on-save → monorepos / JS + Python.
3. Never regress JS projects: every phase ends with the regression gate (§4).
4. Need nothing installed beyond what a pytest project already has (pytest; `coverage` for
   coverage) — no extension-side Python packages.

## 2. Ground rules

| Rule | Detail |
|---|---|
| Branches | CLAUDE.md: never work on `main` / `release/*`; `feat/pytest-<phase>` chained; push, no agent PRs (D1). |
| Test repos are read-only | `/Users/eshandias/Projects/test/{jest-test-projects,vitest-projects,python-projects}` are never edited; `e2e/real-repos.js` clones and checks `git status` + HEAD before/after. The clone's `.venv` is reused, never rebuilt in the original. |
| Dependency direction | `vscode-extension → core → runner`. Interpreter resolution that needs the Python extension API lives in the extension and is passed down as a plain `{ python: string }` option. |
| Spawn, never exec | All Python processes (probe, collect, runs) via `spawn` / the existing `Executor`. |
| Logging | `logger.scope()` / `createLogger()`; inside pytest the plugin writes `[LTR:<level>] msg` to stderr (CLAUDE.md rule 8) — never `print`. |
| Never back-fill output | A test that never ran individually shows the placeholder; module-level output belongs to the file scope only. |
| Docs with every change | Both CHANGELOGs, `docs/architecture.md`, `docs/ai-context.md`, `docs/developer-guide.md` (Adding a framework), READMEs, `docs/framework-features.md` + `node scripts/framework-matrix.js`; gifs/screenshots → `<!-- [TODO: USER_INPUT_NEEDED] … -->`. |
| No breaking settings | New settings only (D16); `testFilePatterns` keeps its JS default — Python patterns come from pytest config. |

## 3. Findings that shaped this plan

### 3.1 Facts about the environment and tools (verified 2026-10-23)

- pytest **9.1.1** (2026-06-19) is current. 9.0 dropped Python 3.9, added native TOML config
  (`[tool.pytest]` in `pyproject.toml`, or `pytest.toml` / `.pytest.toml` with a `[pytest]`
  table; cannot be combined with `[tool.pytest.ini_options]`), experimental built-in
  `subtests`, and a `strict` option. Config files pytest reads, in its own precedence:
  `pytest.toml`/`.pytest.toml` (9+), `pytest.ini`/`.pytest.ini`, `pyproject.toml`
  (`[tool.pytest]` 9+ or `[tool.pytest.ini_options]`), `tox.ini` `[pytest]`, `setup.cfg`
  `[tool:pytest]`. Defaults: `python_files = test_*.py *_test.py`, `python_classes = Test*`,
  `python_functions = test*`, `testpaths` optional.
- coverage.py **7.17.0** (2026-10-22) is current and needs Python ≥ 3.11 (7.17 dropped 3.10) —
  projects on older Pythons have older coverage; the JSON report must be read
  version-tolerantly. JSON has an explicit format number since 7.4.1; **per-function and
  per-class regions since 7.6.0**, `start_line` for them since 7.13.1. The `sysmon` core
  (Python 3.12+ `sys.monitoring`) is the default on 3.14+ since 7.9.1; branch measurement with
  sysmon only on 3.14+ (coverage falls back to its C tracer otherwise — transparent to us).
- pytest-cov **7.1.0**: `--cov-context=test` labels contexts `<node id>|setup|run|teardown`
  (e.g. `test_fancy.py::test_parametrized[1-101]|run`). coverage.py's own
  `dynamic_context = test_function` labels by *function name only* — not unique across
  classes/params, so **our plugin calls `Coverage.switch_context(node_id)` itself** (the same
  API pytest-cov uses).
- `coverage json --show-contexts` (or `cov.config.set_option("json:show_contexts", True)` +
  `cov.json_report()` from the API) writes, per file, `executed_lines`, `missing_lines`,
  `excluded_lines`, `executed_branches` / `missing_branches` (arc pairs, negative = exit),
  `contexts` (line → labels), `functions` / `classes` (7.6+), `summary`.
- VS Code: the **Python Environments** extension went GA on 2026-02-18 and environment
  workflows move to it; the stable consumer API remains `@vscode/python-extension`
  (`PythonExtension.api()` → `environments.getActiveEnvironmentPath(resource)`,
  `resolveEnvironment()`, `onDidChangeActiveEnvironmentPath`) — used by Microsoft's own
  debugger extension. Debugging uses the **Python Debugger** extension
  (`ms-python.debugpy`, launch `"type": "debugpy"`).
- CI: `actions/setup-python` (current major at implementation time; v6 when last checked)
  installs Python on all three OS runners.

### 3.2 pytest facts we build on

| Need | pytest | Notes |
|---|---|---|
| Run once | `python -m pytest [paths / node ids]` | `-m` also puts the cwd on `sys.path` (differs from the `pytest` script; same as the VS Code Python extension). |
| Select one test / class | node id `path::Class::test[param]` (absolute paths work) | `-k` matches substrings and markers → wrong scope; not used. |
| Machine output | plugin hooks: `pytest_collectreport`, `pytest_collection_finish(session)` (items: `nodeid`, `path`, `location` = (relpath, **0-based** line, domain)), `pytest_runtest_logstart(nodeid, location)`, `pytest_runtest_logreport(report)` (`when` = setup/call/teardown, `outcome`, `duration`, `longreprtext`, `longrepr.reprcrash` (path, lineno, message), `sections` / `capstdout` / `capstderr` / `caplog`, `wasxfail`), `pytest_runtest_logfinish`, `pytest_sessionfinish(exitstatus)` | Plugin loaded with `-p ltr_pytest` (module on `PYTHONPATH`); works under xdist (reports arrive on the controller). |
| Collection errors | a failed `CollectReport` per module; by default the session stops ("Interrupted: N errors during collection") | Always pass `--continue-on-collection-errors`; a failed collect → `FileRunResult.failureMessage`. |
| Exit codes | 0 ok · 1 failures · 2 interrupted · 3 internal error · 4 usage error · 5 no tests collected | 5 = "pass with no tests". 4 usually = an `addopts` flag from a plugin not installed in the chosen interpreter → explain. |
| Listing | `--collect-only -q` (imports test modules and conftests) | The plugin writes the collected items as JSON → runnable list **and** the real tree incl. parametrize ids. |
| Output capture | per test and phase: `Captured stdout/stderr/log <phase>` sections | Module-level output during collection → collect report sections → file scope. `-s` / `--capture=no` → goes to the process stdout. |
| Failures | `longreprtext` (assertion rewriting diff included), `reprcrash` for file:line | Use `reprcrash.lineno` (1-based? → **0-based in `ReprFileLocation`**: verify in spike 0.3) for the inline diagnostic. |
| Hang | no built-in limit (pytest-timeout is a plugin) | Our heartbeat (`test-start` / `test-end`) + the existing hang limit; kill the process tree (xdist workers included — `killTree` already does trees). |
| Related tests | none built in (`pytest-testmon` is a plugin with its own database) | Coverage contexts (3.5) + import graph fallback. |
| Debug | `debugpy` launch `module: "pytest"`, `args: [nodeid, …]`, `python: <interpreter>` | |
| Coverage | coverage.py API inside the plugin | `source` from `[run] source`, pytest-cov's `--cov=` values, else coverage's default (files under the cwd that were imported). |

### 3.3 Where the code assumes JavaScript (audit)

The framework seams from the Vitest work hold (`FrameworkAdapter`, `CommandRunner`,
`IFrameworkAdapter`, `FrameworkServices`, `IBatchRunner`, `IProjectConfig`, optional
`instrumentedRunner`). What still assumes JS:

| # | Assumption | Where |
|---|---|---|
| P1 | **Test identity is a JS name regex.** SessionManager joins names into a regex (`names.map(nameToPattern).join('\|')`) and the adapter/runner receive only that pattern (`runTestCase(…, fullName, …)` → `TestRunner.runTestCaseJson(file, pattern, isSuite)` → `RunRequest { kind: 'testCase', testFullName }`). A node-id framework cannot recover names from an escaped alternation. | `session/SessionManager.ts` `_runTestCases` (pattern built ~l.857), `framework/RunnerBackedAdapter.ts` `runTestCase` (l.116), `runner/src/CommandRunner.ts` `RunRequest`, `runner/src/TestRunner.ts` `runTestCaseJson`, `utils/testNames.ts` `nameToPattern` |
| P2 | **On-save filter only passes JS/TS** — a saved `.py` file is ignored before any framework is asked. | `SessionManager.onSave` (`!/\.(c\|m)?[jt]sx?$/i`, l.431) |
| P3 | **Static discovery is Babel-only and global**: `TestDiscoveryService` `require`s `instrumentation/shared/testDiscovery.js` directly; default patterns are Jest's testMatch; `JS_TS_RE` filters files. | `session/TestDiscoveryService.ts` (l.10, `DEFAULT_TEST_PATTERNS`, `JS_TS_RE`, `_discoverFile`), `utils/babel.ts` |
| P4 | **Test-file classification** defaults to JS (`*.test.*`, `__tests__`, `[jt]sx?`). Router uses the primary adapter's `isTestFile` for unknown files. | `RunnerBackedAdapter.getFileGlob` / `isTestFile` (l.77–84), `FrameworkRouter._frameworkOf` |
| P5 | **Coverage scan & rules are JS**: `SourceCounter` parses with Babel and includes `**/*.{js,ts,jsx,tsx}`; `coverageRules` excludes `.(test\|spec).(js\|ts\|jsx\|tsx)`; `istanbulCoverage` logs "from Vitest coverage"; `FrameworkCapabilities.coverage` is defined as "istanbul-format JSON". | `coverage/SourceCounter.ts` `run`, `coverage/coverageRules.ts`, `coverage/istanbulCoverage.ts` `applyIstanbulCoverage`, `runner/src/types.ts` |
| P6 | **Binary resolution is Node-only**: `FrameworkAdapter.resolveBinary` is documented as "must use the project's node_modules"; `Executor.buildInvocation` runs `.js` with `nodeRuntime()`, else spawns the binary directly (an absolute `python` path works as is); `processLabel` defaults to `jest`; env sets `NODE_ENV=test` (harmless). | `runner/src/framework/adapters/FrameworkAdapter.ts`, `execution/Executor.ts`, `resolution/BinaryResolver.ts`, `CommandRunner.processLabel` |
| P7 | **Project discovery reads package.json only**: `hasOwnTestConfig`, `testFrameworkOf`, `workspaceGlobs` (pnpm / npm workspaces), `expandWorkspaceGlobs` (requires `package.json`); projects inside another project's root are **dropped** (a Python `backend/` under a JS root would vanish); project names from `package.json#name`; "open a folder with a package.json" messages. | `runner/src/framework/projectDiscovery.ts`, `project/ProjectRegistry.ts` (l.54, l.104), `extension.ts` (l.346) |
| P8 | **The router knows exactly two frameworks**: `RoutedFramework = 'jest' \| 'vitest'`, `other(primary)`, `projectFrameworks()`, factories `Record<RoutedFramework, …>`; `ProjectContext` builds only the Jest and Vitest bundles; `FrameworkDetector` falls back to plain Jest for anything unknown (a Python-only folder would get a Jest WARN and Jest runs). | `runner/src/framework/allowedFrameworks.ts`, `frameworkRouting.ts`, `FrameworkDetector.ts`, `framework/FrameworkRouter.ts`, `project/ProjectContext.ts` (l.129) |
| P9 | **Conformance suite** writes a `package.json` fixture and asserts "does not claim a folder without package.json". | `runner/test/adapterConformance.ts` |
| P10 | **Runnable-files cache key** hashes `package.json` and JS config files; must include pytest config files, root `conftest.py` and the interpreter path. | `session/RunnableFiles.ts` |
| P11 | **Diagnostics report** is Jest-shaped (package.json, babel-jest). | `utils/diagnostics.ts` |
| P12 | Trace data only arrives as JSONL files from the JS transform — but `ExecutionTraceStore.setSourceMapping` / `mergeLineToTests` / `addCoveredLines` are public, so contexts can feed it without trace files (no change needed, just a second producer). | `store/ExecutionTraceStore.ts` |

Not coupled (verified): `ResultStore` (names are opaque strings; template matching via
`nameToPattern` works for `test_x[…]` → `test_x\[.*\]`), `CoverageStore` / gutter / hover
(read `Manifest` + counters), `ConsoleEntry.scope`, `FileRunResult.failureMessage`,
`isConfigFile` (per bundle), `SessionManager._runAffectedWith` (uses the trace store, then
`batchRunner.runRelated`, then `adapter.runRelatedTests`).

### 3.4 Jest/Vitest ⇄ pytest behaviour map

| Extension feature | Jest / Vitest | pytest | Phase |
|---|---|---|---|
| Pass/fail tree | `--json` / json reporter | plugin `file-end` records in `FileRunResult` shape | 2 |
| Run file / test / suite | paths, `-t` regex | paths, node ids (class = suite) | 1.1, 2 |
| Runnable list | `--listTests` / `vitest list` | `--collect-only` + plugin JSON | 2 |
| Static discovery | Babel AST | TS line scanner (D12) | 2 |
| Session / stop / hang | spawn + kill tree, heartbeats | same; heartbeats from the plugin | 2 |
| Per-test output | Jest per file / Vitest per test | per test and phase | 3 |
| Failure diagnostics | stack parsing | `reprcrash` + `longreprtext` | 3 |
| Coverage | istanbul JSON | coverage.py JSON → `Manifest` / counters | 4 |
| Debug | node launch | `debugpy` launch | 5 |
| Covering tests / precise on-save | trace transform / (Vitest: planned) | coverage contexts | 6 |
| Related fallback | `--findRelatedTests` / `vitest related` | import graph → whole files | 6 |
| Monorepo | package.json workspaces | pytest roots, uv workspace members | 7 |
| Mixed | Jest + Vitest router | language router (D13) | 8 |

## 4. Regression gate (end of **every** phase)

1. `pnpm build && pnpm lint && pnpm test`, plus `python -m pytest packages/runner/python-tests`
   (plugin unit tests, from phase 2).
2. `node e2e/run.js --all` — all JS fixtures + the pytest fixtures as they land.
3. `node e2e/real-repos.js` — the 3 light Jest repos + 3 Vitest repos (+ `jest` monorepo
   before a release), then the Python repos below once phase 2 exists. Pass criterion:
   extension results equal a plain `python -m pytest` on the same clone, test by test.
4. CI green on Linux / Windows / macOS (e2e job gains `actions/setup-python`).

**Real Python repos** (read-only, `LTR_E2E_PYTHON_REPOS_DIR`, default
`/Users/eshandias/Projects/test/python-projects`; sizes approximate — task 0.2 records exact
counts in the baseline file):

| Repo | Size | Shape | Why |
|---|---|---|---|
| `pallets/click` | ≈ 1.3 k tests, ~40 files, runs in seconds | `pyproject.toml` config, `tests/` + conftest fixtures, heavy `parametrize`, captured output | the clean **3.4 target** (light) |
| `encode/httpx` | ≈ 1.2 k tests | `[tool.pytest.ini_options]` with `filterwarnings = error`, async tests (anyio), coverage config in pyproject | async + strict config + coverage settings (light) |
| `pytest-dev/pytest` | ≈ 4 k tests, minutes | `-n auto`-style xdist usage, `testing/`, the hardest collection cases | heavy, opt-in (like the `jest` monorepo); xdist path (D14) |
| *(3.6 only)* `streamlit/streamlit` | large; Vitest frontend + pytest backend in one repo | JS + Python in one workspace | mixed-language check, heavy, opt-in |

Each repo needs a `.venv` with its test extras installed once by the owner
(`uv sync --all-extras` / `pip install -e .[test]`); the harness reuses it in the clone.

## 5. Target architecture

```
runner (no VS Code)
  FrameworkRegistry ── + PytestAdapter (family "python", own priority space)
  PytestAdapter        detect · resolveBinary(python) · resolveConfig(ini path) · getExtraArgs
                       · outputFileArg · parseResult · capabilities(per pytest/coverage version) · createRunner
  PytestRunner extends CommandRunner
     leadingArgs: ['-m','pytest', …paths | node ids]
     buildArgs:   -p ltr_pytest --continue-on-collection-errors -o cache_dir=<session>
                  [-n 0 for scoped runs] [--no-cov if pytest-cov] [--co for list] + pytestArgs
     runEnv:      PYTHONPATH=<session>/py:<existing>, PYTHONUNBUFFERED=1, LTR_PYTEST_EVENTS=<file>,
                  LTR_PYTEST_COVERAGE=<dir|''>
     processLabel 'pytest'
  framework/pytest/
     ltr_pytest.py           source of truth (plugin: events, results, output, coverage+contexts)
     pytestPluginSource.ts   generated from the .py at build (written to <session>/py/ at runtime, like vitestReporter.ts)
     pytestConfig.ts         find rootdir/inifile, read python_files/classes/functions, testpaths, addopts (ini + TOML)
     pytestNodeIds.ts        fullName ⇄ node id codec
     pytestEvents.ts         parse the JSON-lines events → FileRunResult / RunResult
     pythonProbe.ts          `python -c <probe>` → { python, pytest, coverage, xdist, pytestCov, debugpy }

extension
  python/PythonInterpreter.ts   D7 resolution; Python extension API (optional, dynamic import); change events
  framework/PytestAdapter.ts    extends RunnerBackedAdapter: debug config (debugpy), isTestFile from pytest config
  framework/pytestServices.ts   { framework:'pytest', displayName:'pytest', terms, features{trace:false→true in 3.5, timeline:false},
                                  adapter, projectConfig: PytestProjectConfig, batchRunner: PytestBatchRunner,
                                  instrumentedRunner: undefined, staticDiscoverer: pythonDiscovery,
                                  watchesFile: /\.py$/, settingsFingerprint (pythonPath, pytestArgs, interpreter), isConfigFile }
  session/PytestBatchRunner.ts  IBatchRunner: one process per batch, events file tail → applyFileResult/onFileStart/
                                  onFileDone, per-test hang limit, kill tree; runRelated (3.5)
  session/PytestProjectConfig.ts IProjectConfig: ini path; coverageScope() from [run] source/omit (includesUntouched
                                  when source is set — coverage.py reports unimported files itself, so no SourceCounter scan)
  session/discovery/pythonDiscovery.ts  D12 scanner (same output shape as testDiscovery.js)
  coverage/coveragePyCoverage.ts plugin's coverage file → Manifest + LiveCov → CoverageStore; contexts → ExecutionTraceStore (3.5)
  framework/LanguageRouter.ts   (3.6) .py → pytest bundle, rest → FrameworkRouter (Jest/Vitest)
```

**Plugin protocol** (`LTR_PYTEST_EVENTS`, one JSON object per line; mirrors the Vitest reporter):

```
{ "ev":"collected", "items":[{ "nodeid","file","line","classes":[…],"name","param"? }], "errors":[{ "file","message" }] }
{ "ev":"file-start", "file" }
{ "ev":"test-start", "file", "nodeid" }          heartbeat (hang limit)
{ "ev":"test-end",   "file", "nodeid", "result": TestCaseRunResult, "output":[ConsoleEntry…] }
{ "ev":"file-end",   "file", "result": FileRunResult }
{ "ev":"coverage",   "file": "<path to compact coverage json>", "worker": "gw0"|null }
{ "ev":"session-end","exit": 0..5 }
```

- Results are built in Python from the three phase reports of a test (setup error → failed
  "error in setup of …", teardown error → failed after a pass, xfail → `skipped`
  (`failureMessages` = reason), strict xpass → failed). `location.line` = item line + 1.
- Output: each phase's sections → `ConsoleEntry { type: stdout|stderr|log, scope:'test',
  scopeName: fullName }`; collect-time output → `scope:'file'`; class-scoped fixture output
  stays with the test whose phase printed it (never copied to other tests).
- Coverage in the plugin: `coverage.Coverage(data_file=<session>/cov/.coverage.<pid>,
  config_file=<project's rc or True>, source=<pytest-cov --cov values if any>)`, started in
  `pytest_load_initial_conftests` (so conftest / module import lines count — same moment
  pytest-cov starts), `switch_context(nodeid)` around each test's phases, `""` for
  collection; at `pytest_sessionfinish` → `stop/save` → `set_option("json:show_contexts",
  True)` → `json_report()` → rewritten into a compact file: per source file `statements`,
  `executed`, `arcs` (executed + missing), `functions`, and `contexts` as indexes into one
  test-id table (the raw JSON repeats every label per line and gets large). Under xdist each
  worker writes its own file; the extension merges.

**Coverage mapping into the existing model** (no change to `CoverageStore` / gutter / hover):

| coverage.py | `Manifest` / `LiveCov` |
|---|---|
| each statement line (executed ∪ missing) | `statements["L<n>"] = { start:{line:n,col:0}, end:{line:n,col:<len>} }`, `s["L<n>"] = executed ? 1 : 0` |
| arcs grouped by source line (`from > 0`) | `branches["B<n>"] = { type:"branch", line:n, arms:<distinct destinations> }`, `b["B<n>"] = [hit per arm]` (exit arcs labelled "exit" in the hover) |
| `functions` regions (≥ 7.6; skipped before) | `functions["F<i>"] = { name, start:{line:start_line ?? min(lines)}, end:{line:max(lines)} }`, `f = any executed line ? 1 : 0` |
| hit counts | coverage.py records *whether*, not *how often* → counters are 0/1 (the hover must not print "×1" as a count — check in 4.2) |

**Covering tests (3.5)** — from the same compact file: per source line the test ids →
`traceStore.mergeLineToTests()`; per source file → `setSourceMapping()` with suite = class
(or the module for top-level tests), `testCases` = fullNames, `isSharedVars = false`
(module/class fixtures are rebuilt per run, a node-id run is isolated). Then
`SessionManager._runAffectedWith` runs exactly those tests — unchanged code.

## 6. Phases & tasks

### Phase 0 — Housekeeping & spikes (3.5 d)

**0.1 Branch, version, plan (0.5 d)** — `release/3.4.0` from `main` after 3.1.0 ships (or
the release order the owner picks for 3.2/3.3); version bump in root +
`packages/vscode-extension/package.json`; `## 3.4.0 (unreleased)` in both CHANGELOGs; commit
this plan to `docs/temp_plans/pytest-support-plan.md`.
Done when: branch pushed, PR checks green.

**0.2 Python repos + harness (1.5 d)** — `e2e/real-repos.js`: `LTR_E2E_PYTHON_REPOS_DIR`,
entries `click`, `httpx` (light), `pytest` (heavy), scenario `repo-pytest` comparing against
plain `python -m pytest -p no:cacheprovider` on the clone (with the clone's `.venv`); baseline
counts per file into `docs/temp_plans/pytest-baseline.json`; read-only guarantee as today.
Done when: the harness records a plain-run baseline for all three repos and proves the
originals unchanged (the scenario itself fails until phase 2 — expected).

**0.3 Spike: plugin & coverage (1.5 d)** — throwaway `ltr_pytest.py` on click / httpx /
pytest: confirm (a) `-p` module loads before `pytest_load_initial_conftests`, (b) per-phase
sections and `reprcrash` line base, (c) xdist: reports on the controller, plugin loaded in
workers, (d) `switch_context` cost on the pytest repo (target < 15 % over a coverage run
without contexts), (e) compact coverage file size vs raw `json --show-contexts`, (f) `-s` in
`addopts`. Findings → §3.2 and ADR-9 below.
Done when: each item answered with numbers; ADR-9 written.

### Phase 1 — Decouple from JavaScript (8.5 d) — *no user-visible change*

**1.1 Test identity: names, not regexes (2 d)** (P1)
Sketch: `SessionManager._runTestCases` passes `names: string[]` (and `isSuite`) instead of a
joined pattern; `IFrameworkAdapter.runTestCase(store, file, { names, isSuite }, …)`;
`RunRequest { kind:'testCase', file, names, isTestSuite }`; Jest/Vitest runners build their
regex from `names` with `nameToPattern` themselves (moved from SessionManager). Timeline's
`JestInstrumentedRunner` keeps its own pattern.
Tests: Jest + Vitest arg snapshots (`jestRunnerArgs`, `vitestRunnerArgs`) unchanged byte for
byte; SessionManager unit test for multi-name grouping.
Done when: snapshots unchanged, `git grep nameToPattern` shows no use in `session/`.

**1.2 File classification per framework (1.5 d)** (P2, P4, P5)
Sketch: `FrameworkServices.watchesFile(path)` (JS bundles: today's regex; pytest: `.py`) used
by `onSave` via the provider (`IFrameworkServicesProvider.watches(path)`); router asks each
bundle; `coverageRules` test-file patterns gain `test_*.py` / `*_test.py` / `conftest.py`;
`SourceCounter` runs only when the bundle's coverage scope says `includesUntouched` **and**
the bundle declares a source scanner (pytest: none — coverage.py lists unimported files
itself); `FrameworkCapabilities.coverage` doc → "writes coverage the bundle can map".
Done when: unit tests for the filter (JS unchanged, `.py` ignored by JS-only projects), gate green.

**1.3 Static discovery behind the bundle (1.5 d)** (P3)
Sketch: `FrameworkServices.discoverStructure(source, filePath, root)` returning today's
`{ suites, rootTests }` shape; JS bundles delegate to `shared/testDiscovery.js`;
`TestDiscoveryService` asks `services.servicesFor(file)` and takes its file list from
`listTestFiles` patterns per bundle (`DEFAULT_TEST_PATTERNS` / `JS_TS_RE` move into the JS
bundles). Discovery cache keyed as today.
Done when: discovery e2e checks (basic, vitest-basic, mixed-*) unchanged.

**1.4 Runtime resolution (1 d)** (P6)
Sketch: `FrameworkAdapter.resolveBinary` doc → "the program to spawn (a JS entry point run
with Node, or an absolute executable)"; `RunnerOptions.runtime?: { python?: string }` passed
from the extension; `CommandRunner.processLabel` abstract-with-default per runner;
`Executor` test: an absolute non-JS binary spawns directly, args unquoted, no shell (Windows
included).
Done when: Executor unit tests cover the Python-style invocation on all OSes (CI).

**1.5 Projects & routing for N frameworks (2 d)** (P7, P8, P9, P10)
Sketch: `RoutedFramework` → `FrameworkId` in the router internals (factories become a map);
`FrameworkDetector` returns `unknown` (no Jest fallback) when a registered *non-JS* adapter
family claims the folder; adapters get a `family: 'js' | 'python'`; `projectDiscovery` treats
folders without `package.json` (adapter `detect()` only), and the "inside another project"
drop rule applies **per family**; project names fall back to `[project].name` from
`pyproject.toml`, then the folder name; messages say "a test project" instead of "a
package.json"; conformance suite takes `fixture.files` instead of a fixed `package.json`;
runnable cache key includes the bundle's `cacheKeyFiles()`.
Done when: all 7 real repos still detect as one project each; `projectDiscovery.test.ts`
gains Python-only / JS-root-with-Python-subfolder cases (with a fake `python` family adapter).

**1.6 Gate (0.5 d)** — full regression gate; `docs/developer-guide.md` "Adding a framework"
updated (non-JS runtimes, `watchesFile`, `discoverStructure`, conformance fixture files).

### Phase 2 — pytest: run & pass/fail (14 d) — *Feature P1*

**2.1 Interpreter resolution (2 d)** (D7)
Sketch: extension `python/PythonInterpreter.ts`: setting → `PythonExtension.api()` (dynamic
`import('@vscode/python-extension')`, guarded; `getActiveEnvironmentPath(folderUri)` +
`resolveEnvironment` → `executable.uri`) → `VIRTUAL_ENV` → `.venv` / `venv` / `env`
(`bin/python`, Windows `Scripts\python.exe`) in the project root then the workspace folder →
`poetry env info -p` (only with `poetry.lock`, spawned, 5 s limit) → PATH `python3` /
`python` / `py -3`. Windows: reject the Microsoft Store alias stub (`…\WindowsApps\python.exe`
that fails the probe). Runner `pythonProbe.ts`: one spawn printing
`{ version, executable, pytest, coverage, xdist, pytest_cov, debugpy }`, cached per
interpreter path + mtime. `onDidChangeActiveEnvironmentPath` / setting change → stop + clear
the project's runnable cache, INFO log, the next Start uses the new interpreter.
Tests: unit (resolution order with fakes on all OS path shapes, probe parsing, store-alias
rejection).
Done when: the log shows `Python 3.12.4 (.venv) · pytest 9.1.1 · coverage 7.17.0` for the fixture.

**2.2 Runner `PytestAdapter` + config reader (1.5 d)**
Sketch: `detect(root)`: `pytest.toml` / `.pytest.toml` / `pytest.ini` / `.pytest.ini` /
`pyproject.toml` with `[tool.pytest]` or `[tool.pytest.ini_options]` / `tox.ini [pytest]` /
`setup.cfg [tool:pytest]` / root `conftest.py`, or a `pyproject.toml` / `setup.py` /
`requirements*.txt` mentioning pytest plus `test_*.py` / `*_test.py` under `tests/` or the
root. `pytestConfig.ts`: pytest's own file precedence; reads `testpaths`, `python_files`,
`python_classes`, `python_functions`, `addopts` (detect `-n`, `-s`, `--cov`) — INI by a small
parser, TOML by a small vendored parser (`smol-toml`, MIT, ~10 KB) — keep within runner.
`capabilities()` per probe: `coverage` only with the `coverage` package; `related` true
(import graph); `listTests`, `nameFilter`, `liveStream` true. Registered with family
`python`.
Tests: detect matrix (each config kind, a JS project, a JS project with a stray `tests/x.py`
helper → not claimed), config precedence, conformance suite.

**2.3 `ltr_pytest.py` plugin (3 d)** (D9)
Sketch: the protocol in §5; status mapping; `longreprtext` ANSI-free (`--color=no` passed);
collection errors per module; `pytest_sessionfinish` writes `session-end`; xdist-aware
(controller-only for events; `config.workerinput` check). `pytestPluginSource.ts` generated
by `scripts/embed-python.js` (`--check` in lint fails on drift).
Tests: `packages/runner/python-tests/` run with pytest 7.4 / 8.4 / 9.1 in CI (tox-less matrix
via `uvx --with pytest==X pytest …` or setup-python + pip): pass, fail, error in setup /
teardown, skip, xfail/xpass, parametrize ids with spaces and unicode, class + nested class,
unittest.TestCase, collection error, `-s`, xdist (when installed).

**2.4 `PytestRunner` + node-id codec (2 d)** (D10, D14, D15)
Sketch: commands — full: `python -m pytest -p ltr_pytest --color=no
--continue-on-collection-errors -o cache_dir=<session>/pytest-cache [pytestArgs]`; files:
absolute paths; test case: `<abs file>::<Class>::<test>[<param>]` per name (class = suite;
a template name `test_x[…]` → `…::test_x`, all cases); scoped runs add `-n 0` when xdist is
loaded; list: `--collect-only -q` (+ plugin `collected`); exit 5 → passed with no tests; exit
4 → error with the stderr tail ("an addopts flag needs a plugin missing from <interpreter>").
Codec: `^((?:[A-Za-z_]\w* )*)([A-Za-z_]\w*(?:\[.*\])?)$` → classes + title; anything else →
run the whole file + WARN.
Tests: arg snapshots (`pytestRunnerArgs.test.ts`), codec round-trip incl. spaces / brackets
in ids, exit-code mapping.

**2.5 Extension adapter, project config, services, batch runner (2.5 d)**
Sketch: `framework/PytestAdapter.ts` (extends `RunnerBackedAdapter`; `isTestFile` from
`python_files` globs + `testpaths`); `PytestProjectConfig` (ini path; `coverageScope` in
phase 4); `PytestBatchRunner` (one process per batch; tails the events file; `onFileStart`
on `file-start`; `applyFileResult` on `file-end`; per-test hang limit from heartbeats; kill
tree; generation/ownership like `VitestBatchRunner`); `pytestServices.ts` with `terms`
(`pytest config` / `python_files / testpaths` / `pytest --collect-only` / `import graph` /
`pytest batch` / `plain pytest`); `ProjectContext` registers the factory.
Done when: Start on the fixture shows every test passing/failing live with per-file progress.

**2.6 Static discovery for Python (1.5 d)** (D12)
Sketch: `pythonDiscovery.ts`: tokenises lines, tracks indentation, skips triple-quoted strings
and comments, follows `class Test*` / `unittest.TestCase` subclasses (one level of local base
classes), `def` / `async def` matching `python_functions`, decorators
(`@pytest.mark.parametrize` → template `name[…]`; `@pytest.mark.skip` noted), nested classes;
1-based lines; same `{ suites, rootTests }` shape.
Tests: unit corpus (click / httpx test files copied as fixtures under `test/fixtures/python`),
compares with the plugin's `collected` items: names and lines equal except parametrize
expansion.

**2.7 Tests (1.5 d)** — fixture `e2e/fixtures/pytest-basic` (pyproject config, `tests/` with
a class, a parametrized test, a failing assert, a skipped / xfail test, a slow test for hang,
conftest fixture; `.venv` created by the e2e runner with pinned `pytest==9.1.1`); scenarios
`pytest-full-run`, `pytest-scoped-run` (test, class, parametrized template), `pytest-stop`,
`pytest-hang`, `pytest-on-save` (test file save), `pytest-no-pytest` (interpreter without
pytest → the actionable message). CI: `actions/setup-python` in the e2e job on all three OSes.
Done when: gate green incl. `repo-pytest` on click and httpx → **M1**.

### Phase 3 — Output & failure details (3 d) — *Feature P2*

**3.1 Per-test output (1.5 d)** — map sections to `ConsoleEntry` (test / file scope);
collect-time output to the file; `-s` in `addopts` (or `pytestArgs`) → one WARN ("output is
not captured — shown per file"), output from the process stdout to the file scope; Results
pane shows stdout / stderr / log groups as Vitest does. Never back-fill.

**3.2 Failures & inline diagnostics (1 d)** — `reprcrash` path:line → `utils/diagnostics.ts`
inline error at the failing line in the test *or* the source file; full `longreprtext` (with
assertion-rewriting diff) in the errors column; setup/teardown errors labelled.

**3.3 Tests (0.5 d)** — e2e `pytest-output` (per-test print / logging / stderr; a test that
never ran individually shows the placeholder), unit tests for the section mapping.

### Phase 4 — Coverage (5 d) — *Feature P3*

**4.1 Coverage in the plugin (2 d)** (D11) — start/stop/contexts as §5; honour the project's
coverage config file (`.coveragerc`, `setup.cfg [coverage:*]`, `tox.ini`, `pyproject
[tool.coverage.*]`); `--no-cov` when pytest-cov is loaded; reuse its `--cov=` sources;
`branch` follows the project's config (off by default, like `coverage run`); per-worker files under xdist; missing `coverage` package → no coverage, one
actionable WARN + Coverage tab message.

**4.2 Mapping into `CoverageStore` (1.5 d)** — `coverage/coveragePyCoverage.ts` per §5 table;
paths through `fromRunnerPath` (case/drive rules on Windows); manifest per file version
(hash of statements + arcs) so batches merge counters like istanbul entries; `coverageScope`
from `[run] source` / `include` / `omit` (`includesUntouched` = `source` set);
hover text for 0/1 counters; JSON format/version tolerant (≥ 7.0; functions only ≥ 7.6).

**4.3 Tests (1.5 d)** — fixture `e2e/fixtures/pytest-coverage` (`src/` package, `[tool.coverage.run] source`, branch on, one untested module); e2e `pytest-coverage` (gutter lines, branch hover, totals equal `coverage report` on the same run ±0), `pytest-coverage-missing` (no `coverage` installed); unit tests on mapping (arcs → arms, exit arcs, functions).
Gate → **M2**.

### Phase 5 — Debug (2 d) — *Feature P4*

**5.1 Debug config (1 d)** — `{ type:'debugpy', request:'launch', name:'Debug pytest: <test>',
module:'pytest', args:[<node id>, '-p', 'no:cacheprovider', '--no-cov' (if pytest-cov),
'-n', '0' (if xdist), '--color=no', ...pytestArgs], python:<interpreter>, cwd:<root>,
justMyCode:false, console:'integratedTerminal' }`; Python Debugger extension missing →
message with an "Install" button (`workbench.extensions.search ms-python.debugpy`).

**5.2 Tests (1 d)** — unit test of the config; e2e `pytest-debug` (session starts and
stops; breakpoints not asserted, like `vitest-debug`). Gate.

### Phase 9 — Docs, matrix & release 3.4.0 (4.5 d)

**9.1 Docs (2 d)** — feature matrix (pytest column + "Mixed JS + Python" row) via
`node scripts/framework-matrix.js`; README (settings `pythonPath`, `pytestArgs`;
requirements: Python ≥ 3.8, pytest ≥ 7, `coverage` for coverage, Python Debugger for
debug; gif placeholder `<!-- [TODO: USER_INPUT_NEEDED] gif: pytest project — live results, per-test output, coverage gutter -->`);
guide HTML; `docs/architecture.md` (Python runtime, plugin protocol, coverage mapping);
`docs/ai-context.md`; `docs/developer-guide.md` (Python dev setup: `uv`/venv for fixtures,
`python-tests`); both CHANGELOGs.

**9.2 Real-repo validation (2 d buffer)** — click, httpx, pytest (heavy); findings into
`docs/bugs-and-issues.md`.

**9.3 Release prep (0.5 d)** — e2e against the packed `.vsix`; owner opens `release/3.4.0 →
main`.

### Phase 6 — Covering tests & related on-save (6 d) — *3.5.0, Feature P5*

**6.1 Contexts → trace store (2 d)** — compact coverage file contexts → `mergeLineToTests`,
`setSourceMapping`, `addCoveredLines`; `features.trace = true` for pytest (hover lists
covering tests; "not available" text gone); stale entries dropped when a test file reruns.

**6.2 Import-graph fallback (2 d)** — before any coverage data: TS scan of `import x` / `from
x import y` (relative + absolute, resolved against the rootdir, `testpaths`, `src/` layout and
`pythonpath` ini option), transitive, cached per file mtime; `PytestBatchRunner.runRelated`
runs the dependent test files whole; conftest.py saved → every test under that folder; no
dependents → DEBUG "no test depends on X".

**6.3 Tests (2 d)** — e2e `pytest-related` (source save → only the covering tests rerun, by
node id; before coverage → whole files via imports; conftest save), unit tests for the
import resolver (src layout, namespace packages, relative imports). Gate → **M3**.

### Phase 7 — Python monorepos (5 d) — *3.6.0, Feature P6*

**7.1 ADR + discovery (2 d)** — a pytest root (config file per §2.2) is one project; uv
workspaces (`[tool.uv.workspace] members`) → one project per member with tests; a root with
its own pytest config that names `testpaths` into members is **not split** (same rule as
ADR-7 (iv)); nesting drop per family (1.5).
**7.2 Per-project interpreter (1 d)** — each project resolves its own interpreter
(`getActiveEnvironmentPath(projectUri)`, per-member `.venv`); switcher shows
`pytest · .venv (3.12)`.
**7.3 Tests (2 d)** — fixture `monorepo-pytest` (uv workspace, 2 members, different
interpreters not required); scenarios via `monorepo-select/run/stop` parametrised. Gate.

### Phase 8 — JS + Python in one folder (5 d) — *3.6.0, Feature P7*

**8.1 `LanguageRouter` (2 d)** (D13) — wraps the project's `FrameworkRouter`: `.py` and
pytest config files → pytest bundle, the rest → JS router; `listTestFiles` = union;
`isMixed()` true; status bar `Jest 12 · pytest 30`; Explorer groups by framework (ADR-8 UI);
coverage totals per project (JS and Python files never overlap — no merge needed).
**8.2 Detection (1 d)** — a root that a JS adapter *and* the pytest adapter claim → one
project, both bundles; a Python subfolder with its own pytest config → its own project.
**8.3 Tests (2 d)** — fixture `mixed-js-python` (Jest + pytest at one root) and
`mixed-js-python-monorepo` (JS root, `backend/` pytest project); e2e full run / on-save (a
`.py` save never wakes Jest and vice versa) / stop kills both. Real repo: streamlit (opt-in).
Gate → **M4**.

**ADR-9 (to be written in 0.3)** — plugin protocol + coverage contexts, measured overhead,
xdist behaviour, `-s` handling, the `reprcrash` line base.

## 7. Totals

| Phase | Feature / release | Tasks | Days |
|---|---|---|---|
| 0 | Housekeeping & spikes — **3.4.0** | 3 | 3.5 |
| 1 | Decouple from JavaScript — **3.4.0** | 6 | 8.5 |
| 2 | pytest run & pass/fail (P1) — **3.4.0** | 7 | 14 |
| 3 | Output & failures (P2) — **3.4.0** | 3 | 3 |
| 4 | Coverage (P3) — **3.4.0** | 3 | 5 |
| 5 | Debug (P4) — **3.4.0** | 2 | 2 |
| 9 | Docs, validation, release — **3.4.0** | 3 | 4.5 |
| | **3.4.0 total** | **27** | **≈ 40.5 d** |
| 6 | Covering tests + related on-save — 3.5 | 3 | 6 |
| 7 | Python monorepos — 3.6 | 3 | 5 |
| 8 | JS + Python in one folder — 3.6 | 3 | 5 |
| | Release prep for 3.5 / 3.6 | 2 | 1 |
| | **Everything** | **38** | **≈ 57.5 d** |

M1 = phases 0–2 (≈ 26 d): pytest runs and shows pass/fail live.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Phase 1 changes the test-case run contract (P1) and regresses Jest/Vitest scoped runs | Arg snapshots committed first; e2e scoped-run scenarios for both; small commits, gate after each |
| Wrong interpreter (global Python, Store alias, stale venv) → "pytest not found" or wrong deps | D7 order with the Python extension first; probe + one clear message naming the interpreter and the fix; interpreter in the log line of every Start |
| Collection imports test modules: slow (Django, heavy imports) or side effects at list time | Listing only at Start and cached by the runnable-files key (config files + test file list + interpreter); static discovery keeps the UI populated meanwhile |
| `addopts` with plugins / flags our runs don't expect (`--cov`, `-n`, `-x`, `--lf`, `-p no:…`, `-s`) | Read `addopts` (2.2); counter-flags where needed (`--no-cov`, `-n 0` for scoped runs, `-o cache_dir`); `-x`/`--maxfail` → WARN (a batch stops early, missing files retried individually as today) |
| Two coverage tracers (pytest-cov + ours) or coverage overhead with contexts | `--no-cov` when pytest-cov is loaded; spike 0.3 measures context overhead; contexts can be switched off by setting if > 15 % |
| `-s` / `capture=no` loses per-test output | Detected; file-level output + WARN (documented, never back-filled) |
| Static scanner misreads Python (decorated classes, `exec`, conditional defs, dynamic `pytest_generate_tests`) | Real results replace discovered nodes on the first run (ResultStore already reconciles); scanner corpus tests on real repos; `ast` helper is the documented fallback (D12) |
| Parametrize ids with odd characters (spaces, brackets, unicode escapes) break the name ⇄ node-id codec | Codec unit corpus; anything unparseable runs the whole file + WARN, never a wrong test |
| Doctest items (`--doctest-modules`) and `subtests` (pytest 9) don't fit the tree | v1: doctests shown under their module file (file is added to the store); subtests reported as one test with failures listed; matrix footnote |
| xdist output ordering / worker crashes | Events only from the controller; a crashed worker's tests come back missing → existing retry path |
| Windows: `Scripts\python.exe`, `py` launcher, `::` in node ids vs drive letters, long paths | Absolute paths + `::` are accepted by pytest; Executor no-shell spawn; CI matrix on Windows for every pytest scenario |
| CI time grows (Python setup + venvs on 3 OSes) | One cached `uv` venv per fixture (`actions/cache` on `~/.cache/uv`); Python unit tests in the Tests job only on Linux |
| Python extension API changes with the Environments extension rollout | Optional, guarded dynamic import; fallbacks (D7) work without it; unit tests with a fake API |

## 9. Open questions for the owner

1. **D2** — baseline pytest ≥ 7 / Python ≥ 3.8 for the plugin, nothing older? (recommend yes)
2. **D3** — include Debug in 3.4.0? (recommend yes, 2 d)
3. **D4 / D5** — release split 3.4 → 3.5 (covering tests, related) → 3.6 (monorepos, JS + Python)? And should 3.4 follow or precede the Vitest trace (3.3)?
4. **D6** — Timeline for pytest out of scope? (recommend yes)
5. **D7** — interpreter order, incl. using the Python extension's selected interpreter first and calling `poetry` when `poetry.lock` exists? (recommend yes)
6. **D11** — drive coverage.py from our plugin and pass `--no-cov` to pytest-cov during our runs? (recommend yes)
7. **D12** — TS line scanner for static discovery rather than a Python `ast` helper or tree-sitter? (recommend scanner)
8. **D13** — JS + Python at the same root = one project with a language router (not two switcher entries)? (recommend one project)
9. **D14** — keep the project's xdist `-n` for batches, `-n 0` for scoped runs? (recommend yes)
10. **D16** — settings `pythonPath` + `pytestArgs` only, no `pytestCommand` for now? (recommend yes)
11. **D17** — repo folder `/Users/eshandias/Projects/test/python-projects` with click, httpx, pytest (+ streamlit for 3.6); will you prepare their `.venv`s?

## Progress tracker

- [ ] 0.1 Branch, version, plan
- [ ] 0.2 Python repos + harness
- [ ] 0.3 Spike: plugin & coverage (ADR-9)
- [ ] 1.1 Test identity: names, not regexes
- [ ] 1.2 File classification per framework
- [ ] 1.3 Static discovery behind the bundle
- [ ] 1.4 Runtime resolution
- [ ] 1.5 Projects & routing for N frameworks
- [ ] 1.6 Gate + developer guide
- [ ] 2.1 Interpreter resolution
- [ ] 2.2 Runner PytestAdapter + config reader
- [ ] 2.3 ltr_pytest.py plugin
- [ ] 2.4 PytestRunner + node-id codec
- [ ] 2.5 Extension adapter, project config, services, batch runner
- [ ] 2.6 Static discovery for Python
- [ ] 2.7 Tests (M1)
- [ ] 3.1 Per-test output
- [ ] 3.2 Failures & diagnostics
- [ ] 3.3 Tests
- [ ] 4.1 Coverage in the plugin
- [ ] 4.2 Mapping into CoverageStore
- [ ] 4.3 Tests (M2)
- [ ] 5.1 Debug config
- [ ] 5.2 Tests
- [ ] 9.1 Docs + feature matrix
- [ ] 9.2 Real-repo validation
- [ ] 9.3 Release prep → **3.4.0**
- [ ] 6.1–6.3 Covering tests + related on-save → **3.5.0** (M3)
- [ ] 7.1–7.3 Python monorepos → 3.6.0
- [ ] 8.1–8.3 JS + Python in one folder → **3.6.0** (M4)
