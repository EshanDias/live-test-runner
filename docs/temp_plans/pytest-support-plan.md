# pytest Support & Language Decoupling — Task Plan (release 3.2.0)

> Working document, same format as `docs/temp_plans/vitest-support-plan.md`.
> Work tasks top to bottom and tick the box in the [Progress tracker](#progress-tracker)
> when one is done. Estimates are *focused working days including tests and docs*, ±30 %.
> Written 2026-10-23 against `feat/mixed-frameworks` @ `ff83b27` (3.1.0 unreleased:
> phases 7 + 8 of the Vitest plan done; Vitest trace phase 9 still open).

## 0. Decisions

Owner answers of 2026-10-23 / 24 are marked **decided**. No row is open.

**Owner, 2026-10-24:** the release previously called "3.4.0" in this plan ships as **3.2.0**
(changelogs: a `3.2.0 (unreleased)` section; the version is not bumped on these branches).
The phase branches start from `feat/vitest-any-frontend` (agent 1's Vitest/Jest work,
PR #51 → `release/3.1.0`); when the 3.2.0 scope is done, a **test PR to `release/3.1.0`**
proves CI green — never merged by the agent. Wherever the text below says 3.4 / 3.5 / 3.6,
read 3.2 / 3.3 / 3.4.

| # | Decision | Status |
|---|---|---|
| D1 | One `feat/pytest-<phase>` branch per phase, chained, the first from `feat/vitest-any-frontend`; each branch committed and pushed. The agent opens only a **test PR** (last branch → `release/3.1.0`) to run CI, never merges it (owner, 2026-10-24). | **decided** |
| D2 | **Baseline versions (owner, 2026-10-23):** pytest **≥ 7.0**, Python **≥ 3.12** (older Pythons are out of support for this tool; note: 3.11 still gets security fixes until Oct 2027 — flagged, owner's call stands). The plugin may use 3.12 syntax. Tested matrix: pytest 7.4, 8.4, 9.1 × Python 3.12, 3.13, 3.14. Older → "not supported" message naming the found versions, no best-effort mode. | **decided** |
| D3 | **First release (3.4.0) = one Python project:** run, pass/fail, per-test output, failures with diffs, live per-test progress, hang limit, ▶ Run / ▷ Debug one test or class, rerun a saved test file, coverage (gutter + hover). Debug included (owner). | **decided** |
| D4 | **3.5.0** = "covering tests" in the hover + precise source-file on-save reruns, both from coverage.py **dynamic contexts** (one context per test, written by our plugin) — no tracer of our own. Fallback before the first coverage run: static import graph → whole test files. | **decided** (owner: split is fine) |
| D5 | **3.6.0** = Python monorepos (one project per pytest root) and **JS + Python in the same folder**. pytest work starts after the Vitest trace (phase 9 of the Vitest plan). | **decided** |
| D6 | **Timeline debugger: out of scope for every framework for now** (owner) — first support every framework we can; the timeline is a later extra touch. Matrix cell "— later". | **decided** |
| D7 | **Python interpreter (owner, 2026-10-23).** Order: (1) **the user's own choice** — a **Select Python Interpreter** command / clickable status item (quick pick of every environment found + "Browse…"), remembered per project in the extension's own storage (`workspaceState`, never `.vscode/settings.json` — rule 9), and the optional `liveTestRunner.pythonPath` setting; (2) **virtual environments inside the project**: `.venv` / `venv` / `env` (uv, `python -m venv`, pip users, poetry with in-project envs), then the tool's own answer when its lock file is there and the env lives elsewhere — `poetry env info -p` (`poetry.lock`), `pipenv --venv` (`Pipfile.lock`), uv's `UV_PROJECT_ENVIRONMENT`; (3) the Python extension's interpreter for that folder (optional API); (4) an activated environment (`VIRTUAL_ENV` / `CONDA_PREFIX`) **only when it lies inside the project**; (5) `python3` / `python` on PATH (`py -3` on Windows). **Activation is not needed:** we run the venv's own `python` directly (`.venv/bin/python -m pytest`), which is what activation amounts to — nothing changes in the user's shell. **Always shown:** the chosen interpreter and why ("`.venv` (uv) · Python 3.13 · pytest 9.1") in the Explorer header / status bar tooltip, clickable to change. **None found, or no pytest in it:** a notification "Select a Python interpreter for <project>" with Select / Browse buttons — nothing runs until one is chosen. | **decided** |
| D8 | **Strict rule (owner): never install anything into the user's project or environment and never edit their code or config.** Everything the tool needs ships inside the extension (plugin, helpers); anything we write is a temporary file in our session folder. Goal: install the extension, click Start — no configuration. Missing pytest → error naming the interpreter and how to fix it ("select the project's environment", "`pip install pytest`" — a hint, never run by us). Missing `coverage` → tests run, coverage shows an actionable message. | **decided** |
| D9 | **Results come from our own pytest plugin** (`ltr_pytest.py`, loaded with `-p ltr_pytest` from the session folder on `PYTHONPATH`) streaming JSON lines per event — not JUnit XML (no live events, no per-phase output, no locations) and not `pytest-json-report` (an install). | proposed |
| D10 | **Test identity:** a pytest test's `fullName` = its classes + function name + parametrize id, space-joined (`TestCart test_total[2-items]`), exactly like Jest/Vitest ancestors + title. The runner turns names back into **node ids** (`<abs file>::TestCart::test_total[2-items]`) — never `-k`, which matches substrings and keywords. | proposed |
| D11 | **Coverage via coverage.py driven by our plugin** (`coverage.Coverage` API, the project's own `[coverage:run]` / `[tool.coverage]` settings, data file in the session folder). pytest-cov is **not** required; when it is installed we add `--no-cov` **to our own command line only** so two tracers never run at once in our run. Nothing is written to the repository; the user's own terminal runs (`pytest`, `pytest --cov`) are untouched and can run at the same time. | **decided** (owner: the plugin must never interfere with what the user does) |
| D12 | **Static discovery: the TypeScript line scanner** (owner: smallest package, fast) — reads `.py` as text for `def test*` / `async def test*` / `class Test*` / `unittest.TestCase` subclasses, honouring `python_files` / `python_classes` / `python_functions`; no interpreter needed. It only drives the instant first view; at Start pytest's own collection replaces it, so accuracy where it matters comes from pytest. | **decided** |
| D13 | **Projects are what the user built** (owner): every project root is a project; JS and Python under one root stay **one project**, files routed by language (`.py` → pytest bundle, everything else → the Jest/Vitest router); status bar `Jest 12 · pytest 30`; Explorer groups by framework. We never invent structure. Different folders → separate projects, as phase 7 does. | **decided** |
| D14 | **xdist (owner: recommended approach, under D19):** keep pytest-xdist when the project uses it, but **cap the workers to our resource budget on our own command line**. Refined after spike 0.3: our runs always pass `-n 0` when xdist is installed — the parallelism comes from our own batches, which already stay within the budget (D19), so there are never workers on top of batches; one process per batch also keeps events and coverage in one place. | **decided** |
| D15 | **Keep the user's repo clean:** `-o cache_dir=<session>/pytest-cache` (our partial runs never rewrite the user's `--lf` state), coverage data file in the session folder. `.pyc` files are left to Python (setting `PYTHONPYCACHEPREFIX` would recompile every session). | proposed |
| D16 | **New settings:** `liveTestRunner.pythonPath` (string, '' = auto, D7), `liveTestRunner.pytestArgs` (string[] appended to every run). No `pytestCommand` override (a `uv run` / `poetry run` wrapper is covered by D7's interpreter resolution); revisit if users ask. | **decided** (owner, 2026-10-24) |
| D17 | Real Python repos for the regression gate live in `/Users/eshandias/Projects/test/python-projects` (read-only, like the Jest/Vitest ones): `click`, `httpx`, `erdantic` (pytest 7), `pytest` (heavy). Cloned and their `.venv`s prepared by the agent on 2026-10-24 (owner: "feel free to clone real repositories") — §4. | **decided** |
| D18 | **Test identity and selection are framework-neutral (owner: abstract it so the next framework does not hit this again).** `SessionManager` stops building name regexes (`nameToPattern(...).join('|')`); it passes structured **`TestRef`s** (file, the path of names from the outermost suite to the test, template/parameter info) to the framework. Each services bundle creates its **`TestSelector`** (strategy, made by the bundle's factory like the batch runner) that turns `TestRef`s into that framework's selection: Jest/Vitest → the existing anchored name pattern, pytest → node ids. Same for result mapping (`TestRef` ↔ store node). Phase 1 task 1.1 (replaces the P1 finding). | **decided** |
| D19 | **Resources first (owner):** we never overuse the machine — whatever else the user does must stay responsive. Every kind of parallelism (batches, frameworks in a mixed project, projects in a workspace, pytest-xdist workers) is bounded by one budget from free resources (cores, memory), like `maxRunningProjects` and the batch concurrency today; when the budget is 1, things run one at a time. | **decided** |

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
| `drivendataorg/erdantic` | 153 tests, 12 s | **pytest 7.4** (`pytest<8`), `addopts` with pytest-cov (`--cov … --cov-report=html/xml`), pytest-cases | the pytest 7 target (D2); proves `--no-cov` keeps `htmlcov/` and `coverage.xml` out of the project (light) |
| `pytest-dev/pytest` | ≈ 4 k tests, minutes | `-n auto`-style xdist usage, `testing/`, the hardest collection cases | heavy, opt-in (like the `jest` monorepo); xdist path (D14) |
| *(3.6 only)* `streamlit/streamlit` | large; Vitest frontend + pytest backend in one repo | JS + Python in one workspace | mixed-language check, heavy, opt-in |

Each repo has a `.venv` with its test extras (prepared 2026-10-24 with `uv venv` + `uv pip install`;
the harness reuses it in the clone). **Baseline, plain `python -m pytest -p no:cacheprovider`
on this Mac (2026-10-24):**

| Repo | pytest / Python / coverage | Result |
|---|---|---|
| click @ 2247b35 | 9.1.1 / 3.12.14 / 7.17.0 | 2261 passed, 25 skipped, 1 xfailed, 31000 deselected — 8.3 s |
| httpx @ b5addb6 | 9.1.1 / 3.12.14 / 7.17.0 | 1413 passed, **4 failed** (environment), 1 skipped — 8 s |
| erdantic @ HEAD | **7.4.4** / 3.12.14 / 7.17.0 | 133 passed, **20 failed** (graphviz build differs; a CLI test calls `python` from PATH) — 12 s |
| pytest @ 4088e1a | 9.2.0.dev / 3.14.7 / 7.17.0 | `testing/`: 4766 collected |

The failures are stable and environmental; the gate compares test by test, so they must
come out the same in the extension. httpx's suite writes a `test` file (SSL key log) into
the cwd and erdantic's `addopts` write `htmlcov/` / `coverage.xml` — real-repo runs happen
only on copies (`e2e/real-repos.js`).

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

**ADR-9 — plugin, coverage and xdist (spike 0.3, 2026-10-24; pytest 9.1.1 / 7.4.4, coverage 7.17.0, Python 3.12 / 3.14)**

| Question | Answer (measured) | Consequence |
|---|---|---|
| (a) does a `-p` plugin load early enough? | yes — `pytest_load_initial_conftests` fires for it before conftests import | coverage starts there (pytest-cov's moment); fallback in `pytest_configure` |
| (b) line bases, sections | `item.location` / `report.location` line **0-based**; `reprcrash.lineno` **1-based**; module-level `print` lands in no test's sections; `item._report_sections` accumulate, so the teardown report holds setup + call + teardown sections | `location.line = item.location[1] + 1`; per-test output from the last phase report, deduplicated by section title |
| (c) xdist | the plugin loads in every worker (`config.workerinput`; *not* on `early_config` — use `PYTEST_XDIST_WORKER`); reports arrive on the controller; `collection_finish` fires only in workers | **our runs pass `-n 0`** (D14 refined): one process, one event stream, one coverage file |
| (d) coverage cost (httpx, 1418 tests) | none 7.75 s · coverage 15.25 s (+97 %) · + `switch_context` per test 18.1 s (+19 %) | coverage only for batches (as Jest/Vitest); contexts (3.3) cost +19 % — acceptable, setting-gated if needed |
| (d′) `COVERAGE_CORE=sysmon` | with dynamic contexts on 3.12 → INTERNALERROR (exit 3) | never force a core; coverage.py picks |
| (e) coverage JSON size | `json_report` **with** `show_contexts`: **1.24 GB** on httpx; compact table from `CoverageData.contexts_by_lineno`: 1.5 MB in 0.5 s | never ask coverage for a contexts report; the plugin writes istanbul-shaped JSON (no contexts) for the gutter, and (3.3) its own compact context table |
| (f) `-s` in addopts | `config.getoption("capture") == "no"`; output goes to the process stdout | one WARN per root; output stays file-level |
| (g) pytester (pytest's own suite runs inner sessions) | an env-var plugin (`PYTEST_PLUGINS` / `PYTEST_ADDOPTS`) would load into every inner session | the plugin is named **only with `-p` on our own command line** |

Coverage is written by the plugin as istanbul-shaped JSON (statements per line, branches
from arcs grouped by source line, functions from coverage ≥ 7.6 regions, 0/1 counters), so
the extension reuses `applyIstanbulCoverage` — the §5 mapping table, done in Python.

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

## Handoff

Where the work stands, for whoever resumes it (an hourly check resumes after usage-limit stops).

- Worktree: `/Users/eshandias/Projects/Personal/live-test-runner-pytest` (the main checkout
  belongs to agent 1). Branches: `feat/pytest-phase0` (this doc) → next phases chained on it.
- Real repos + `.venv`s: `/Users/eshandias/Projects/test/python-projects/{click,httpx,erdantic,pytest}` — read-only.
- 2026-10-24: phase 0 done (decisions, repos, spike, ADR-9).
- 2026-10-28: phases 1–6 + 9.1 / 9.2 done (owner: covering tests + source saves ship in 3.2.0 too).
  Branches (rebased on agent 1's `feat/vitest-any-frontend` @ 1a031e7; a force-push was refused,
  so the rebased chain has new names): `feat/pytest-2-plan` → `feat/pytest-2-decouple` →
  `feat/pytest-2-run` → `feat/pytest-2-related` (→ docs on the same). The old
  `feat/pytest-phase0/-decouple/-run` on origin are stale (owner may delete them).
- Findings during implementation: (1) **one pytest process at a time** — parallel batches
  deadlocked httpx (session fixture binds a fixed port) → `FrameworkServices.batchPolicy`;
  (2) copied `__pycache__` in a repo clone points test locations at the original (real-repos
  drops it); (3) pytest 7 reports a package's `__init__.py` as a collector (not a test file);
  (4) a stale runnable-files list survives plugin changes → the plugin hash is in the key;
  (5) httpx `test_write_timeout` is flaky in plain pytest (1 run in 3) → `FLAKY` in `repo-pytest`.
- Real repos: click 2287 / httpx 1418 / erdantic 153 (pytest 7.4) match plain pytest test for test;
  pytest's own suite 4811 tests (562 s) matched except a doctest `.txt` file (fixed: any file pytest
  lists is kept) and a cache-plugin test (the reference run disabled the cache plugin — fixed).
- Next: full regression, test PR → `release/3.1.0` with CI green (9.3 is the owner's release step).

## Progress tracker

- [x] 0.1 Branch, plan (no version bump — 3.2.0 changelog section, owner)
- [x] 0.2 Python repos + harness
- [x] 0.3 Spike: plugin & coverage (ADR-9)
- [x] 1.1 Test identity: names, not regexes
- [x] 1.2 File classification per framework
- [x] 1.3 Static discovery behind the bundle
- [x] 1.4 Runtime resolution
- [x] 1.5 Projects & routing for N frameworks
- [x] 1.6 Gate + developer guide
- [x] 2.1 Interpreter resolution
- [x] 2.2 Runner PytestAdapter + config reader
- [x] 2.3 ltr_pytest.py plugin
- [x] 2.4 PytestRunner + node-id codec
- [x] 2.5 Extension adapter, project config, services, batch runner
- [x] 2.6 Static discovery for Python
- [x] 2.7 Tests (M1)
- [x] 3.1 Per-test output
- [x] 3.2 Failures & diagnostics
- [x] 3.3 Tests
- [x] 4.1 Coverage in the plugin
- [x] 4.2 Mapping into CoverageStore
- [x] 4.3 Tests (M2)
- [x] 5.1 Debug config
- [x] 5.2 Tests
- [x] 9.1 Docs + feature matrix
- [x] 9.2 Real-repo validation
- [ ] 9.3 Release prep → **3.4.0**
- [x] 6.1–6.3 Covering tests + related on-save → in **3.2.0** (owner, 2026-10-28) (M3)
- [ ] 7.1–7.3 Python monorepos → 3.6.0
- [ ] 8.1–8.3 JS + Python in one folder → **3.6.0** (M4)
