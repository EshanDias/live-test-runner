# Changelog

All notable changes to Live Test Runner are documented here.

## [3.4.1] - Unreleased

### Fixed
- **Coverage is truthful while the session runs** (Jest, Vitest, Angular, pytest). Before, numbers only went up: a deleted test, a deleted test file or code that no longer calls a file left lines covered.
  - `CoverageStore`: each test file's latest run is one contribution (sparse counters per source version, on disk in the session folder `coverage-contrib/`), replaced when the file runs again; a version counts once measured after the file's last change. Unit `coverageContributions`.
  - Jest: records carry their test file (`ltrCoverageSetup.js`). Vitest: wrapper provider `vitestCoverageProvider.mjs` (`coverage.provider=custom`, loads the project's v8 / istanbul) writes coverage per test file with the provider's own `generateCoverage`; Angular through its runner config. pytest: `coverage-per-test-file.json` from the per-test contexts; import-time lines credited to each importing test file (`PythonImportGraph`). Plugin test `test_coverage_is_written_per_test_file`.
  - Background refresh (`SessionManager._scheduleCoverageRefresh`): once idle, test files measured before a change they cover rerun whole (single tests by name and `--findRelatedTests` measure nothing); results are replaced too. Once per change, session only, cancelled by Stop.
  - New source files counted at once (`SourceCounter.countFile`; Python: coverage.py's analysis, `count_files` in the plugin), edited ones recounted, deleted files / folders leave the totals (`diskWatcher.onDidDelete` → `onFilesDeleted`). The coverage refresh steps aside for changes on disk.
  - Coverage tab: **Updating coverage (N files)…** and greyed totals while not final; a note for test files that ran without coverage (plain fallback runs).
  - Hover: covered / not covered from the counters; tests a rerun no longer reaches leave "covered by" (`ExecutionTraceStore.forgetTestFiles`); module-level lines say so.
  - e2e `coverage-live`, `coverage-live-vitest`, `coverage-live-pytest` (`e2e/lib/coverageLive.js`); `basic-on-save` checks the refresh.
- **Suites whose tests share a variable reran single tests** (S4): discovery's `isSharedVars` never reached the rerun choice. Now the whole file reruns (`TestDiscoveryService.sharedSuiteIds`); `const x = require(...)` no longer counts as shared state. Unit `testDiscovery`, e2e `coverage-live`.

### Security / tooling
- Performance measurement: `scripts/perf-project.js` (synthetic 2.5k-file Jest project), `scripts/perf-measure.js` + e2e `diag-perf` (discovery, first result, full run, trace / coverage parse, memory, save rerun; results in local `e2e/baselines/perf.json`). Trace and coverage parse time and size in the debug log.

## [3.4.0] - 2026-11-09

### Added
- **Angular 21+** (Vitest through `ng test`; fixes BUG-46, where every test failed with `describe is not defined`).
  - `AngularAdapter` / `AngularRunner`: `ng test <project>` per Angular project, our reporters, a runner config in the session folder, `CI=true` (no `.angular/` cache in the project).
  - One workspace = one project; `AngularBatchRunner` splits batches by Angular project.
  - Saves rerun the importing test files (`jsImporters.ts`); templates rerun their component's tests.
  - Coverage needs `@vitest/coverage-v8` in the project. Karma: a clear warning.
  - Detected only when the builder runs the tests: Vitest is a dependency and the `test` script doesn't run Jest (jest-preset-angular apps stay Jest).
  - e2e `angular-full-run`, `angular-debug`, `angular-snapshot-update`; unit `angularRunner`, `jsImporters`.
- **Failures on the failing line** (D2): message after the line, hover with Show diff / Open in Results / Dismiss; hidden on edited lines; setting `showFailuresInEditor`. e2e `failure-on-line`, unit `failureInfo`.
- **Update snapshot** (D3, Jest / Vitest / Angular): modal confirmation naming the file, then the framework's own update flag for that one test. e2e `snapshot-update`, `vitest-snapshot-update`.
- **Copy buttons** (D4): visible copy icon, Copy all, **Copy for AI** (clipboard only), Copy Failing Test Names. Unit `copyText`.
- **`test.todo` icon**; skipped tests get their own gutter icon.
- **Privacy policy** (`PRIVACY.md`) and the AI-features rule (G12, `CLAUDE.md`, `CONTRIBUTING.md`, PR template).

### Fixed
- **Vitest used most of the CPU (fan always on):** each parallel batch started Vitest's default of cores − 1 workers (the project's own `maxWorkers` per process), so 2–4 batches oversubscribed the machine and slow tests ran even slower. Batches now get `--maxWorkers` from one budget: all together use at most half the cores (`workersPerBatch`, runner `utils/resources.ts`); a lower limit in the config (`maxWorkers`, pool `maxThreads` / `maxForks`, `fileParallelism: false`) is kept, read by the config probe; `--minWorkers=1` below Vitest 4 (a higher config `minWorkers` would crash the pool; Vitest 4+ rejects the flag). `SessionManager` takes its batch count from the same `parallelBatches()`. Unit `resources`, `vitestRunnerArgs`; checked against real Vitest 3.2 and 5.0.
- **BUG-43:** instrumented Jest code lost strict mode and `this` in `obj.fn?.()`. Jest monorepo now matches plain Jest. Unit `jestTraceTransform`.
- Wrong stack-trace line numbers from instrumented Jest source files (`retainLines`, runtime on line 1, transformer map passed on).
- **BUG-45:** ▷ Debug of a Jest / Vitest test could hang (command typed into a slow-starting terminal, or `?` unescaped for zsh on VS Code < 1.90). Now `internalConsole`.

### Changed
- **No network calls**: the shipped guide loads nothing remote (pictures are links); CSP without `https:`; guarded by `noNetwork.test.ts` (also bans AI-service SDKs).
- **Minimum VS Code 1.82** (was 1.74), from a written policy: Node end of life + 2 years (`scripts/support-floor.js`, monthly check).

### Security / tooling
- `security.yml`: dependency audit (`scripts/security-audit.js`), dependency review, CodeQL.
- PR job `E2E (minimum VS Code)`.
- Dependencies: ESLint 10.14, typescript-eslint 8.72, globals 17.14, shipped Babel parser 7.29.12; TypeScript stays on 6.0 (typescript-eslint does not support TS 7 yet); `overrides` for dev-only advisories (18 → 3); pnpm installs only versions ≥ 7 days old.
- Dependabot: grouped minor/patch PRs, one PR per major; no Babel parser majors.
- CI: `actions/setup-python` v7 (from Dependabot #65; only `python-version` and `cache: pip` are used, both unchanged in v7).
- CodeQL findings fixed:
  - Runners with no session folder write temp files into a private `mkdtemp` folder (`utils/tempDir.ts`, `CommandRunner.workDir`), not loose names in the shared temp root.
  - Read-then-write instead of check-then-read: `AngularRunner` runner config, `scripts/support-floor.js`.
  - Linear-time regexes: `stripAnsi` (an unterminated OSC no longer rescans), `RunnerPaths` trailing-slash trim; two test regexes replaced with `includes`.
  - Workflows: `pnpm/setup` pinned to a commit hash; `pr-checks.yml` token read-only.

## [3.3.0] - 2026-11-07

### Added
- **Python monorepos (uv workspaces).** A root with `[tool.uv.workspace] members` (and `exclude`) and no pytest config / `conftest.py` of its own is split into one pytest project per member with tests (its own pytest setup, or test files when the root names pytest). A root with its own pytest config or `conftest.py` stays one project; members without tests are none.
  - `projectDiscovery.ts`: `jsProjectsInFolder` + new `pythonProjectsInFolder`, both returned by `projectsInFolder`. New exports: `uvWorkspaceGlobs`, `configuresPytest`, `mentionsPytest`, `hasPytestTestFiles`; `testFrameworkOf(dir, registry, family?)`; `expandWorkspaceGlobs(root, globs, marker?)`.
  - Interpreter per member: venvs looked up in the project, then each folder above it up to the workspace folder (`venvRoots`; a shared root `.venv` shows as `.venv (<folder>)`). The Python extension is asked for the project's own folder.
  - Tests: `projectDiscovery.test.ts` (6 uv cases), `pythonDiscovery.test.ts` (`venvRoots`); e2e `pytest-monorepo` (`fixture:monorepo-pytest`), `pytest-venv-per-service` (`fixture:monorepo-pytest-venvs`), `multi-root-js-python` (two workspace folders). Harness: `workspace` may be an array (opens a `.code-workspace`); every fixture folder with `requirements-e2e.txt` gets its own `.venv`.
- **JS and Python in one folder.** A Jest / CRA / Vitest root that is also a pytest project is one project running both (`projectFrameworks` adds `pytest`).
  - `.py` files go to pytest; switcher shows `jest + pytest` (session log: `framework: jest + pytest`), Explorer groups by framework, status bar splits (`Jest 2 · pytest 3`).
  - Discovery: `mixedDiscoverer` (Babel for JS / TS, the line scanner for `.py`; `TestFileDiscoverer.excludeFor`); `ProjectContext.usesFramework('pytest')` shows the Python chip.
  - Saves wake only their language (`FrameworkServices.language`, `SessionManager._loadsSource`).
  - No Python → the JS tests still run: a non-main framework that cannot run (`whyNotReady`) is left out for the session (`IFrameworkServicesProvider.disable`, INFO line).
  - Python subfolders (`backend/` next to a JS app) found two levels down (`nestedPythonRoots`, skipping dependencies, environments and build output).
  - Tests: `projectDiscovery.test.ts` (3), `frameworkRouting.test.ts` (1); e2e `mixed-js-python`, `mixed-js-python-monorepo`.
- **The Coverage tab says when coverage is off**, and what to install: `FrameworkServices.coverageOffReason(root)` → `CoverageStore.setOffReasons` → `CoverageTotals.off` (`cov-off-note`). Before: a table of 0 % rows. Tests: `coverageOff.test.ts`; e2e `pytest-no-coverage` (`fixture:pytest-no-coverage`).
- **Open test files run first** on Start, in batches of their own; a file opened while queued moves to the front (`SessionManager.promote`). Queue logic in `session/batchQueue.ts`. Tests: `batchQueue.test.ts` (5); e2e `basic-open-first`.
- **Coverage bars on every line of a multi-line statement** (`coverage/statementLines.ts`; a statement holding others marks only its first line, so an uncalled function body never looks green). Used by the bars and the hover's counter fallback; works without the trace. Totals unchanged. Replaces the old `trace-driven-decorations.md` plan. Tests: `statementLines.test.ts` (5); e2e `coverage-editing`.

### Fixed
- **Tests that write many files restarted the session forever** (3.2.1 bug, seen on the Jest monorepo: "53 files changed on disk during the run — restarting").
  - Changes queued during our runs never restart (more than 20 left are logged, not rerun); unrun test fixtures are dropped; late watcher reports inside our runs count as ours (`_writtenDuringLastRuns`); a disk restart never repeats for the same files. e2e `disk-changes` step 5b.
- **A Jest batch retries once when a test deleted a file mid-crawl** (`ENOENT` on a vanished file; `vanishedFile`, `IBatchRunner.runFiles` → `retry`) instead of falling back to plain Jest per file. Tests: `vanishedFile.test.ts` (3). Known issue: jest-runtime's own tests still fail under the session run.
- **Files tests write no longer start extra runs** (unplugin: 11 extra Vitest processes). `_runQueuedDiskChanges` drops a queued file the last run's trace knows no test of (`_unusedByLastRun`). e2e `disk-changes`.
  - Real-repo matrix (unplugin, slidev, vueuse, also on `main`): `repo-vitest` now restores edited files through the editor and waits for that rerun.

### Changed
- **Timeline Debugger labelled "planned"**, not "preview" (guide, website, README); the guide no longer lists its command or log message, and `Open Timeline Debugger` shows only with `liveTestRunner.devMode`.
- **Internal: framework router for any number of frameworks.** `ROUTED_FRAMEWORKS` (`jest`, `vitest`, `pytest`) replaces the `'jest' | 'vitest'` pair; `projectFrameworks` lists every framework (`routedFrameworkOf`: CRA / unknown → `jest`); `parseFrameworkRules(setting, base, allowed)` (`SETTING_FRAMEWORKS`); `FrameworkRouter` takes a factory per framework (`FrameworkFactories`); `IFrameworkServicesProvider.frameworks()`. pytest uses the router (no `SingleFrameworkProvider`). Tests: `frameworkRouter.test.ts` (4), `frameworkRouting.test.ts` (2).
- **Internal: core's dead coverage map removed** (`CoverageMap`, `SelectionPolicy`, `TestSession.start()` / `getCoverageMap()`, `IFrameworkAdapter.getAffectedTests`). It was always empty. No user-visible change.

### Repository and docs
- Developer docs moved to `docs/development/` (`architecture.md`, `developer-guide.md`, `framework-features.md`, `ai-context.md`); `packages/vscode-extension/DEVELOPER_GUIDE.md` removed.
- Docs in three kinds, listed in `docs/README.md`: `docs/features/`, `docs/requirements/` (mapped to e2e scenarios; ⚠️ = no test), `docs/development/design/`. Pages for test runs, Test Explorer and editor, on-save reruns, Results panel, coverage, debugging, monorepos / mixed frameworks.
- GitHub Wiki generated from `docs/` (`scripts/build-wiki.js`, workflow `wiki.yml`, on merges to `main` or by hand on a release branch), with a contents sidebar and a note that edits belong in `docs/`; PR checks fail on a broken docs link. `docs/README.md`, `CONTRIBUTING.md`, `CLAUDE.md` and the PR template say which pages a change must update.
- Working plans and trackers out of the repository. Real-repo matrix repos come from a gitignored `e2e/real-repos.local.json` (template `e2e/real-repos.example.json`, public open-source projects; `kind` jest / cra / vitest / components / pytest), so private projects can be tested without their names reaching the repository; baselines go to gitignored `e2e/baselines/`.
- Contribution paths: issue forms, PR template, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1; reports through GitHub's Report content), `SECURITY.md` (private vulnerability reports), Dependabot (weekly grouped npm and Actions updates, one-week delay, held until retargeted to a release branch), `.github/CODEOWNERS` (PRs into `main` and `release/*` need the maintainer's approval). Issue forms ask for versions, framework, OS, project layout and the extension log.
- Licensing: root `LICENSE` (MIT, Eshan Dias (EshLabs)), `license` in every `package.json`; picomatch's license ships as `out/vendor/picomatch.LICENSE`.
- Root `README.md` rewritten as the GitHub landing page; the guide's "Known issues" links to the issue forms; its settings table lists `hangTimeoutSeconds`, `coverageExclude`, `testFilePatterns`.
- Code comments, e2e labels and the changelog no longer cite internal plan phases, decision IDs or bug IDs.

---

## [3.2.1] - 2026-11-05

### Added
- **Files changed outside the editor rerun their tests** (git pull, branch switch, code generators, other editors), like a save (`SessionManager.onFilesChangedOnDisk` → `onFileChanged`; log "Changed on disk:").
  - `session/ExternalChanges.ts` batches file-system events for 500 ms and drops our own saves (2 s window), files with unsaved edits, `node_modules` and `.git`.
  - More than 20 changed files at once (a branch switch) restart the session instead.
  - Changes during a run are queued until it ends; a file changing again during its own rerun is not queued again (warned). Stopped sessions ignore disk changes.
  - Tests: `externalChanges.test.ts` (4); e2e `disk-changes`.
- **Clear All Cached Data** (`liveTestRunner.clearAllCaches`, asks first) and **Open Cached Data Folder** (`liveTestRunner.openDataFolder`).
- **Show / hide coverage in the editor**: setting `liveTestRunner.showCoverageInEditor` (default on), commands **Hide / Show Coverage in Editor** (eye buttons in the editor title). Hidden also turns the coverage hover off.
- **Settings gear** in the Test Explorer title bar (`liveTestRunner.openSettings`).
- e2e `commands`: runs every command from the Command Palette and checks its effect.

### Fixed
- **Stop really stops** (3.2.0 bug): the "Running — 1 / N files" timer kept counting and the CPU stayed busy. `SourceCounter.cancel()` (called by Stop and restarts); `session-stopped` clears the webview timer; `_postProgress` posts nothing after Stop. e2e `basic-stop`.
- **Nothing written into the project:** Select Project Root kept its pin in `.vscode/settings.json`; it now lives in workspace storage (`ProjectRegistry.pinRoot`, key `liveTestRunner.pinnedProjectRoot`). A user-written `liveTestRunner.projectRoot` still works. It also always asks now, even in a single-folder workspace.
- **Clearing really clears:** Stop Testing and Clear Cache / Clear Cache and Restart also delete the runnable-files list (`runnable-files-*.json`), the Jest transform cache and coverage manifests (`transform-cache-*`) and the CRA config (`ltr-cra-config-*.json`).
- **Unused data pruned:** on activation, data unused for 30 days is deleted (`cache/Storage.ts` `pruneUnused`); before, these files were never deleted (Windows never cleans its temp folder). Discovery-cache limit (10 projects / 500 MB) unchanged. A window's session folder is deleted when it closes (`deactivate`). `cache/Storage.ts` knows every path (`transformCacheDir`, `runnableFilesPath`, runner `craConfigPath`). Tests: `storage.test.ts` (2).
- **Commands from the Command Palette:** Rerun Test at Line, Debug Test at Line, Focus Test in Results Panel and Show All Covering Tests now use the cursor (or say what to open). Dump Trace Store shows only with `liveTestRunner.devMode`.

### Changed
- **Coverage bars stay out of the way while editing.**
  - A thin, faded 1px left border (whole-line decoration, `border-image` gradient) instead of a `▌` character in the text: code never shifts, the gutter stays free. Grey "not executable" bars removed.
  - Bars and hover follow unsaved edits: `editor/MeasuredLines.ts` keeps each measurement's text, `lineMatch.ts` matches current lines to it (prefix / suffix + LCS). Edited, new and moved lines get no bar until measured again; spacing is ignored, indentation is not; under half the lines left → no bars until saved. Redraw 150 ms after typing. `CoverageHoverProvider` maps lines the same way.
  - Tests: `lineMatch.test.ts` (12); e2e `coverage-editing`; `diag-coverage-bars` screenshots.

---

## [3.2.0] - 2026-10-30

### Added
- **pytest support.** Every Jest / Vitest feature except the Timeline: static discovery, live per-file results, per-test output, failures, hang limit, Stop, ▶ Run / ▷ Debug (test, class, parametrized function), saved-file reruns, coverage (gutter, hover, totals), covering tests and precise source-save reruns.
  - **Nothing installed or changed in the project:** our own plugin `ltr_pytest.py` (embedded into `ltrPytestSource.ts` by `scripts/embed-pytest-plugin.js`, `--check` in lint), written to the session folder and loaded only with `-p ltr_pytest` on our command line (never `PYTEST_PLUGINS` / `PYTEST_ADDOPTS`).
  - Our runs add `-o cache_dir=<session>/pytest-cache`, `--no-cov` (with pytest-cov), `-n 0` (with pytest-xdist), `--continue-on-collection-errors`, `--color=no`; plain environment plus `PYTHONPATH` (plugin first), `PYTHONUNBUFFERED`, `PYTHONIOENCODING=utf-8` (no `NODE_ENV` / `CI`).
  - **Plugin protocol** (`$LTR_PYTEST_EVENTS`, JSON lines): `config`, `file-start`, `test-start` / `test-end`, `file-end` (a `FileRunResult`), `coverage` / `coverage-off`, `session-end`. `--ltr-result=<file>` writes the `RunResult`; `$LTR_PYTEST_LIST` the files of `--collect-only`.
  - **Results:** setup / teardown errors fail the test ("Error in setup of …"); skip and xfail → skipped (reason kept); strict xpass → failed; names are classes + function + parametrize id (`TestCart test_total[2-items]`); location is the `def` line; per-test output (stdout → log, stderr → error, logging → info), never shared; collection errors fail the file; files with nothing to run report empty; a package's `__init__.py` collector (pytest 7) is not a test file.
  - **Runner:** `PytestAdapter` (family `python`, below every JS adapter), `PytestRunner` (`python -m pytest -p ltr_pytest …`, root-relative files, `runTestsByName` by node id, `liveCommand`, `debugArgs`, `listTestFiles`), `pytestConfig.ts` (pytest's own config order: `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml`, `tox.ini`, `setup.cfg`; detection by config, root `conftest.py` or pytest in the dependency files), `pytestNodeIds.ts` (names ⇄ node ids, never `-k`), `python.ts` (isolated probe of Python, pytest, coverage, xdist, pytest-cov, debugpy; minimums pytest ≥ 7.0, Python ≥ 3.12). `pytestExitReason` explains exit 2 / 3 / 4.
  - **Interpreter** (`python/PythonInterpreters.ts`): **Select Python Interpreter** (`liveTestRunner.selectPythonInterpreter`; every environment found + Browse…, remembered per project in `workspaceState`), `liveTestRunner.pythonPath`, `.venv` / `venv` / `env`, `UV_PROJECT_ENVIRONMENT`, poetry, pipenv, the Python extension's interpreter, an activated `VIRTUAL_ENV` / `CONDA_PREFIX` inside the project, then PATH. The first with pytest wins; the user's choice is never replaced. Logged on every Start. None usable → one notification with **Select Interpreter**, nothing runs (`FrameworkServices.whyNotReady`).
  - **One pytest process at a time** (`FrameworkServices.batchPolicy`: `maxParallel: 1`, up to 300 files per process): projects share fixtures, ports and files (httpx deadlocked with two processes). Scoped and fallback runs follow the cap.
  - **Coverage:** coverage.py started where pytest-cov would, with the project's config and `--cov=` sources from `addopts`; data in the session folder; istanbul-shaped `coverage-final.json` (statements, branches from arcs, functions from coverage ≥ 7.6). Test files, `conftest.py` and environments never count. Without `coverage`, tests run and one line says why.
  - **Covering tests and source saves:** one coverage context per test (`switch_context`, read from `CoverageData.contexts_by_lineno`), written as the same `T` / `H` trace records Jest and Vitest produce. Before coverage exists, `PytestBatchRunner.runRelated` uses a static import graph (`session/pythonImports.ts`; a saved `conftest.py` reruns the tests under its folder).
  - **Decoupled from JavaScript:** `IFrameworkAdapter.runTestCase(…, names)`, `RunnerBackedAdapter.runNamed` (Jest / Vitest command lines unchanged), pluggable `TestFileDiscoverer` (`session/discovery/pythonDiscovery.ts` line scanner: test functions, `Test*` classes, `unittest.TestCase`, nested classes, `parametrize` templates, `python_*` / `testpaths`), `Executor` `jsEnv`, `FrameworkAdapter.family`, Python project names from `pyproject.toml`, `configFileNames` (saving `pyproject.toml` / `pytest.ini` / root `conftest.py` restarts), pytest config in the runnable-files cache key, CodeLens for `.py`.
  - New settings: `liveTestRunner.pythonPath`, `liveTestRunner.pytestArgs`.
  - Tests: runner `pytest.test.ts` (17); plugin `python-tests/test_ltr_pytest.py` (10; CI job **pytest plugin** on pytest 7.4 / 8.4 / 9.1 × Python 3.12 / 3.13 / 3.14); `pythonDiscovery.test.ts` (7), `pythonImports.test.ts` (5). e2e fixtures `pytest-basic`, `pytest-no-pytest`; scenarios `pytest-full-run` (vs plain pytest JUnit), `pytest-scoped-run`, `pytest-on-save`, `pytest-stop`, `pytest-hang`, `pytest-coverage` (totals equal coverage.py's), `pytest-debug`, `pytest-no-pytest`, `pytest-related`. Real repos (`repo-pytest`): click (2287 tests), httpx (1418; one flaky timing test), erdantic (pytest 7.4, pytest-cov in `addopts`) match plain pytest; pytest's own suite (4811, opt-in).
- **Running score card** next to Total / Passed / Failed: tests with status `running` (`getSummary().running`), for every framework. Click it (or **Running** in the status dropdown) to filter. Rides on existing messages as `runningTests`; cards lay out as a flexible grid. Tests: `statusFilter.test.ts`, `resultStore.test.ts`; e2e `basic-running-count`.
- **Python environment chip** under Start / Stop for pytest projects: `🐍 Python 3.12.4 · .venv · pytest 9.1.1` (tooltip: path, where found, coverage version); click → Select Python Interpreter; amber with a reason when it can't run (`pytest not installed · .venv`, `Python 3.9.6 · needs 3.12+`, `No Python found`). Probed quietly when shown (`ensure(root, { quiet: true })`); the first run logs the interpreter at INFO. Files: `python/pythonEnvChip.ts`, `ExplorerView.setPythonEnv`. Tests: `pythonEnvChip.test.ts` (4); e2e `pytest-env-chip`, `pytest-no-pytest`, `basic-full-run`.

### Fixed
- **Coverage started at 100 %** ("0 of 0") before anything was measured; with every total at 0 it now shows 0 % (`testListView.js` `_nothingMeasured`).
- **Running card flickered** when the count touched 0 between files; it now stays from `run-started` / `files-rerunning` to `run-finished` / Stop.
- **pytest durations** are whole milliseconds (were `302.763`).

### Docs
- **README** rewritten short (274 → 166 lines): one hero GIF (`resources/gifs/demo.gif`), feature bullets, `coverage-hover.png`, `monorepo-switcher.png`; every `[TODO: USER_INPUT_NEEDED]` filled.
- **Website** hero: a slider of five scenes (`gifs/scene-*.gif`; tabs, progress bar, arrows, swipe, auto-advance, off with reduced motion); feature images `coverage-hover.png`, `results-panel.png`, `explorer-running.png`; `pages.yml` publishes the scenes at `/gifs/`.
- **Guide:** hero GIF, Vitest and pytest scenes, coverage hover, Results panel; "Jest and Vitest" wording updated where pytest applies too.
- Recording tooling: fixtures `demo-jest` / `demo-vitest` / `demo-pytest`, `diag-demo-*` scenarios, `e2e/lib/demo.js`, `devtools.js` `recorder`, `scripts/demo-gifs.js`. Removed unused images (`code_coverage.png`, `explorer-test-run.png`, `test-results-column-split.png`, `status_bar.png`, `live test runner demo.gif`).

---

## [3.1.0] - 2026-10-28

### Added
- **Monorepos and multi-project workspaces.** Every test project is detected; none runs automatically.
  - Runner `framework/projectDiscovery.ts` (`findTestProjects`, `projectsInFolder`, `workspaceGlobs`, `pnpmWorkspacePackages`, `expandWorkspaceGlobs`, `hasOwnTestConfig`, `testFrameworkOf`): a folder with its own test config is one project (its config covers its packages: the `jest` repo's root `projects`, vueuse / slidev `test.projects`); a monorepo root (`pnpm-workspace.yaml`, `package.json#workspaces`, `*` / `**` / `!` globs) without one gives one project per package with tests; nested and duplicate roots dropped; a lone unrecognised folder stays the project (plain Jest). Tests: `projectDiscovery.test.ts` (11). The real repos (jest, jest-dom, vscode-jest, a CRA project, unplugin, slidev, vueuse) stay one project each.
  - **`ProjectContext` per project** (`src/project/`): its own stores, discovery + cache, framework provider, `SessionManager` (fixed `projectRoot`, status sink) and session folder (`session-<pid>-<ts>/p<N>-<name>`). `ProjectRegistry` owns them and the selected project (remembered per workspace, else the active editor's, else the first); others are discovered on first selection or Start. `ProjectObserverGate` forwards events only for the selected project; switching rebinds the views (`bindProject`, fresh `init`, mid-run progress included).
  - **Editor features decorate every file from its own project** (`editor/FileStores.ts`, `editorObservers`); saves go to the file's project, so a background project keeps rerunning.
  - **Project switcher** at the top of the Explorer (two or more projects): `name ▾ ● running 3/10 ✓120 ✗2`, a menu with framework, path, state and counts. Commands **Select Project** (`liveTestRunner.selectProject`) and **Stop All Projects** (`liveTestRunner.stopAllProjects`); `startTesting` / `stopTesting` take an optional project id.
  - **Status bar** with several projects: `Live Tests: web · ✅ 12 passed · 2 running` (tooltip: every project).
  - **Setting `liveTestRunner.maxRunningProjects`** (`"auto"` = 2, or 1 with ≤ 4 cores or < 8 GB; or a number). Over the limit: "Stop a running project first — …" (`project/projectLimits.ts`, tests (3)).
  - `liveTestRunner.projectRoot` / Select Project Root pin the window to one root (the 3.0 behaviour); "Detect all projects" clears the pin. Changing the setting or folders re-detects (contexts kept when roots are unchanged).
  - **Vitest `test.projects` grouping:** `CommandRunner.listTestFiles()` returns each file's `projectName` (`vitest list --json`, two or more projects; "a, b" for several); cached; `FileResult.group` → one collapsible row per project.
  - A package whose `test` script runs `vitest` is Vitest even when Vitest is installed only at the root. Copy Diagnostic Report lists every project.
  - e2e fixtures `monorepo-jest`, `monorepo-vitest`; scenarios `monorepo-select`, `monorepo-run`, `monorepo-stop`. The e2e API returns `projects` and selected-project getters.
- **Mixed Jest + Vitest projects.** Each test file's framework decides its binary, config, flags, batch runner, reporter and coverage.
  - Runner `framework/frameworkRouting.ts`: `projectFrameworks(root, detected)` (mixed = a Jest marker **and** the root's own `vitest.config.*` / `vitest.workspace.*`; a `vitest` dependency or `vite.config.*` alone stays Jest — jest-dom), `frameworkHint(source)` (imports `vitest` / `@vitest/*` vs `@jest/globals`, then `vi.` / `jest.` calls; comments ignored), `parseFrameworkRules` / `matchFrameworkRule` / `globToRegExp`, `assignFrameworks` (setting → single framework → each framework's own list → hint → primary + WARN). `framework/allowedFrameworks.ts` `allowFrameworkAt`: runners refuse the other framework's root unless allowed. Tests: `frameworkRouting.test.ts` (25).
  - **`FrameworkRouter`** replaces `DetectingFrameworkProvider`; the provider gains `prepare()`, `listTestFiles(root, discovered)` (both frameworks in parallel, each file placed once), `restore(listing)`, `fileChanged(file)` (an added `vitest` import moves a file, INFO), `fingerprint()`, `isMixed()`. Single-framework projects behave as before.
  - **SessionManager:** batches never mix frameworks; the fallback uses the batch's framework; a source save reruns each framework's dependents in parallel and ignores the other's files (`owns`; `runRelatedTests` gets `accept`); either config restarts; session line `framework: jest + vitest`; status bar `· Jest 5 · Vitest 3`.
  - Runnable-files cache stores each file's framework and rule (`"vitest:hint"`).
  - **Coverage across frameworks** (`coverageRules.combineWithEntry` / `mergeByLine`): counters merge by line, a line either framework ran stays covered. Tests: `coverageMerge.test.ts`.
  - UI: files grouped by framework (`Jest`, `Vitest`, `Vitest · <project>`); switcher / diagnostics show `jest + vitest`; the Timeline says "not available yet" for Vitest files.
  - **Setting `liveTestRunner.frameworks`** — `{ "<glob>": "jest" | "vitest" }` (or `{ "framework": … }`), globs relative to the workspace folder, first match wins; also makes a Jest project mixed. Per-glob `config` / `root` not supported (WARN).
  - e2e fixtures `mixed-same-package`, `mixed-monorepo`; scenarios `mixed-full-run`, `mixed-on-save`, `mixed-stop`, `mixed-monorepo`.
- **Vitest execution trace** (as Jest has): the hover lists the tests that ran a line; a source save reruns only those tests (`-t` patterns; a file where every non-skipped test ran it reruns whole, with coverage); `vitest related` is the fallback. Same JSONL records, so `ExecutionTraceStore`, the hover and Show All Covering Tests are unchanged.
  - **How:** a wrapper config (`<session>/vitest-trace/<root>/ltr.vitest.config.mjs`) loads the project's config with its own Vite (`loadConfigFromFile`, `mergeConfig`) and adds the `live-test-runner:trace` plugin: the trace setup file first in `test.setupFiles` (`server.fs.allow`), and an `enforce: 'post'` transform inserting `globalThis.__strace?.step(line, file)` before each statement of the project's own sources, lines read through the source map. Insertions are pure, unmapped and `/* istanbul ignore next */` — coverage unchanged (vueuse, 361 files, identical totals).
  - `vitestTraceSetup.mjs`: test context in `beforeEach` (`fullName` = suites + test), `beforeAll` hits as hooks, flush in `afterAll`; `Function.prototype.toString` hides the inserted calls (slidev's `page.evaluate` tests); hook callbacks take no parameters.
  - **`test.projects`:** inline projects get the plugin (idempotent; Vitest 5 inline `extends` inherits it); file and folder entries (`'packages/*'`) get a wrapper each.
  - **Workers:** one trace file per worker (`<base>.<pid>-<threadId>`, `LTR_TRACE_PER_WORKER`); an `F` record when the setup ran.
  - **Fallback:** the trace turns off until the next Start, with one log line (`VitestTrace`): setting off, Vitest < 3, no Vite, the wrapper failing, a traced batch with no result (rerun without it), or a file run without the setup. The hover then says "covering tests are off for this project — <reason>"; saves use `vitest related`. New `FrameworkServices.traceOffReason()`.
  - **Setting `liveTestRunner.vitestTrace`** (default `true`).
  - Refactor: trace parsing in `session/traceRecords.ts` (`applyTraceRecords`, both frameworks; a retried test's records merge). Runner: `vitestTrace.ts` (`viteEntryFor`, `vitestDirFor`), `resolvePackageDir` exported, `VitestRunner.liveCommand({ config })` / `projectConfigPath()`, `CommandRunner.commandArgs(request, configOverride)`.
  - Whole-file trace reruns when every non-skipped test ran the source; skipped / todo tests no longer force name patterns (Jest too).
  - Tests: runner `vitestTrace.test.ts` (6); `vitestTraceTransform.test.ts` (15), `vitestTraceConfig.test.ts` (9), `traceRecords.test.ts` (3). e2e fixture / scenario `vitest-trace`; `vitest-session`, `vitest-coverage`, `mixed-on-save` use the trace; `vitest-related` runs with it off; `repo-vitest` checks it. A batch stopped by the hang limit still applies its finished files' trace.
- **Any UI framework: components, Vitest workspaces, Jest ESM mode.** If the project's Jest or Vitest runs it, every feature works (React, Solid, Preact, Lit, Angular and Qwik were always plain JS / TS).
  - **What counts as source** (`session/sourceFiles.ts`): JS / TS, compiled formats (`.vue`, `.svelte`, `.astro`, `.marko`, `.mdx`, `.riot`, `.imba`, `.coffee`, `.civet`, `.gjs` / `.gts`, `.elm`), extensions Jest's `moduleFileExtensions` loads (`IProjectConfig.sourceExtensions`; `html` with jest-preset-angular), or anything the trace saw run. Assets, data and docs (`NON_SOURCE_EXTENSIONS`) start nothing. Before, every non-JS/TS save was ignored. Untested components are counted from their `<script>` / Astro frontmatter (`scriptOf`).
  - **Vitest trace reaches components** without an extension list: any module a Vite plugin compiled whose source map leads back to the file (`sourceMapLookup.mapsBackTo`), script and template lines; query sub-modules and map-less components untouched; `nonSourceExtensions` in the wrapper options. Vitest coverage unchanged (Vitest 3.2 / 4.1, Vue 3.5 + Svelte 5).
  - Shared reader `instrumentation/shared/sourceMapLookup.js` (Vitest and Jest transforms).
  - **Jest trace and coverage reach components:** `<root>/**/*.<ext>` routed to our transform for every extension the project transforms itself; the project's transformer runs, its output is instrumented and moved back through its map (`remapLocations`); compiler-added code gets nothing. vue-jest maps `<script>`, svelte-jester the whole component; Vue templates under Jest are marked run when the render function runs (trace only). No map → runs uninstrumented.
  - **Jest's ESM mode:** Node options from the test script or `.npmrc` (`node-options=`; project, monorepo root, else `~/.npmrc` — `npmrcNodeOptions`) reach every Jest we start (`testScriptNodeOptions` / `jestNodeEnv`; ▷ Debug as `runtimeArgs`). A file still failing as ESM gets one WARN per session (`jestEsmHint`). The transform has `processAsync`, loads ESM-only transformers with `import()`, and instrumented ES modules `import` the runtime; the cache key includes the mode.
  - **Vitest 3 workspaces traced:** the wrapper loads `vitest.workspace.*` / `vitest.projects.*` (via the project's Vite; JSON read directly) or `test.workspace`, and passes the list inline; entries' `root` / `extends` resolved against the file's folder. Vitest 4+ has none. Checked on 3.0.9, 3.1.4, 3.2.4.
  - **Type-check files** (`*.test-d.ts`) no longer turn the trace off (reporter tag `typecheck: true`) and rerun on save (`vitest related <src> --typecheck.only`; `IBatchRunner.hasTypecheckFiles`, `RelatedRunOptions.typecheckOnly`).
  - **Any file a test loads reruns its tests (Vitest):** the trace plugin writes the module graph (`LTR_VITEST_DEPS`: `?raw` / `?url` imports, `addWatchFile` templates); `ExecutionTraceStore` (`addImporters`, `isLoaded`, `getDependentTestFiles`) → "Module-graph rerun". `vitest related` finds neither.
  - **Templates named by a relative path (Jest):** saving a non-JS file nothing ran reruns the tests of the sources next to it that name it (`templateUrl: './x.html'`).
  - Tests: `sourceFiles.test.ts` (4), `sourceMapLookup.test.ts` (3), `jestComponentTransform.test.ts` (4), `vitestTraceConfig.test.ts` (+5), `vitestTraceTransform.test.ts` (+2); runner `jestConfig.test.ts` (+4), `vitestReporterSource.test.ts` (+2). e2e `vitest-components`, `vitest-workspace`, `jest-vue`, `jest-svelte-esm`; the plain-Jest comparison uses the script's Node options.

### Fixed
- **Vitest 3.0 / 3.1 failed at startup with Vite 6.4** ("Failed to load custom Reporter"): the reporter now lives at `<session>/node_modules/.ltr/ltr-vitest-reporter.mjs`, which every Vitest from 2 to 4 loads.
- Found on real projects (new `repo-components` real-repo scenario: vue-testing-library, vue-multiselect, jest-preset-angular's Angular 22 example, svelte-testing-library):
  - Babel configs adding `@babel/runtime` imports failed every file: our files are in `transformIgnorePatterns` (`JestProjectConfig.ownFilesPattern`).
  - jest-preset-angular ran TypeScript untranspiled: treated like ts-jest (compile, then instrument); any transformer rejecting instrumented code is compiled first from then on; compiled-first code records source lines through the map (ts-jest too).
  - TypeScript generics broke instrumentation (`.ts` parsed with JSX): now without JSX, with decorators.
  - Babel 8 discovery lost decorators: rejected parser plugins dropped one by one; the fallback includes `decorators-legacy`.
  - A `test` script running only Vitest next to a `jest.config.*` (svelte-testing-library) ran on Jest: the script decides.
  - The ESM hint recognises relative `node_modules` paths.
- **Vitest: one test or suite showed "Could not read Vitest's JSON result"** when the config set a single `outputFile`: `--outputFile=<ours>` now overrides every form (Vitest 1–5) and nothing is written into the project.
- **Vitest 1: one test or suite matched nothing:** `toVitestNamePattern` allows one leading space.
- **Clear Cache and Restart Testing** didn't restart and left the views stale: both cache commands share `stopAndClear`; the restart then waits for fresh discovery. Works without a discovery cache.
- **Mixed coverage:** a called function's first and last line stayed red (Vitest's v8 counts them, Jest's instrumentation doesn't); `mergeByLine` counts them.
- **Jest batches skipped custom `testMatch` / `testRegex` files** (e.g. `*.jest.js`, which fell back to plain Jest one by one): the overlay keeps the project's pattern (`testRegex`, else `testMatch`).
- Tests: `vitestRunnerArgs.test.ts`, `adapterRunContract.test.ts`; e2e `vitest-scoped-run`, `basic-clear-restart`.

### Website and docs
- The website deploys from `main` only (`pages.yml`). Hero badge "New in 3.1 — Monorepos · Jest and Vitest in one project"; table rows for monorepos and mixed projects.
- Screenshots of the switcher and a mixed project, captured from the real UI by opt-in `e2e/scenarios/diag-screenshots*.js` (`LTR_E2E_CDP_PORT` + `LTR_E2E_SHOTS_DIR`; `diag-` never runs in `--all`).

---

## [3.0.0] - 2026-10-22

### Added
- **Vitest support.**
  - **Runner `VitestAdapter`** (replaces the `ViteAdapter` stub; id `vitest`: `FRAMEWORK_IDS.vite` → `.vitest`, `ADAPTER_PRIORITIES.vite` → `.vitest`). Detection: a `vitest` dependency or `vitest.config.*` / `vitest.workspace.*`, and no Jest marker. Binary `vitest/package.json#bin` (`vitest.mjs`) run with node (local, hoisted, pnpm; no `.bin` shim, no npx). Config: `vitest.config.*` before `vite.config.*`. Version sets the capabilities (≥ 3 full; older: runs and results). If Vitest's `engines.node` rules out the editor's Node and none is on PATH, the run stops with an explanation; an old PATH Node is a WARN.
  - **`FrameworkAdapter.capabilities(projectRoot)`**: `FrameworkCapabilities` (`results`, `nameFilter`, `listTests`, `related`, `liveStream`, `coverage`).
  - **`VitestRunner`**: `vitest run [files] … --reporter=json --includeTaskLocation --passWithNoTests --watch=false [-t pattern] --outputFile=<tmp>`, `vitest list --filesOnly --json`, `vitest related <file> --run` (Vitest < 3: full run). No `--root`. `toVitestNamePattern()` matches Vitest 5's `Outer > Inner > adds` and older `Outer Inner adds`. Test-script flags read by `testScriptVitestArgs` (`--config`, `--project`, `--root`, `--dir`, `--mode`, `--environment`, `--globals`, …; follows `nr` / `npm run` / `pnpm` / `yarn` / `bun run`). Checked on unplugin (Vitest 5).
  - **`parseVitestResult()`** (`parsing/VitestResultParser.ts`), built from real reports of Vitest 1.6–5.0 (fixtures): Vitest 1's empty ancestor dropped, counts from the tests, load errors / failing hooks / unhandled errors explained, durations rounded, colour and stack lines stripped. unplugin: all 201 statuses equal plain Vitest.
  - **Projects and the browser-mode guard:** `framework/vitestProjects.ts` asks the project's own Vitest (`createVitest` probe, ~0.5 s, cached) for its projects; browser-mode ones are left out with `--project=<name>` for the rest (one INFO line). Setting **`liveTestRunner.vitestIncludeBrowserProjects`** (default false); `RunnerOptions.includeBrowserProjects`; hook `CommandRunner.prepare()`. Checked on vueuse (136 files).
  - **Session parity:** `FrameworkServices.terms` (log / status wording; Jest's text unchanged) and `features` (`trace`, `timeline`). Verified in VS Code: session guard, saved test / source files, ▶ Run with `-t`, Stop (CLI and workers), hang limits. e2e `vitest-session`, `vitest-stop`, `vitest-hang`; harness `vitestProcesses()`.
  - **Extension:** framework-neutral half of `JestAdapter` moved to `framework/RunnerBackedAdapter.ts`; new `VitestAdapter.ts` (▷ Debug: `vitest.mjs run <file> [-t …] --no-file-parallelism --test-timeout=0`, `autoAttachChildProcesses`), `session/VitestBatchRunner.ts`, `VitestProjectConfig.ts`, `vitestServices.ts`. `DetectingFrameworkProvider` builds the Jest or Vitest bundle. The Timeline says "not available for Vitest yet"; `runMode: npm` ignored for Vitest (one WARN). Setting **`liveTestRunner.vitestCommand`**.
  - **Console output per test:** our reporter (`framework/vitestReporter.ts`, `--reporter=<file>` next to `default` and `json`; JSON to `--outputFile.json=`) records each console call with its task (`onUserConsoleLog`; `LTR_VITEST_EVENTS`); `VitestRunner.afterRun` attaches `scope` / `scopeName`; each test gets exactly its own output. Vitest's default output streams to Test Output (`forwardStdout`). Verified on Vitest 1.6–5.0. Hooks `CommandRunner.runEnv()` / `afterRun()` / `forwardsStdout`. e2e `vitest-output`.
  - **Failure details:** name, message, expected / received diff and `❯ src/a.test.ts:5:30` (first project frame, source-mapped); a failing `beforeAll` / `afterAll` shows its real error. `formatVitestError()`, `errorLocation()`.
  - **Live progress:** the reporter streams `file-start`, `test-start` / `test-end` and `file-end` (Vitest 3+ reporter API; 1–2 `onTaskUpdate`). `VitestBatchRunner` applies them as they arrive (`runWithReporterPolling`); a test over `hangTimeoutSeconds` stops the batch, and a batch with no event for `hangTimeoutSeconds × 3` too (unfinished files retried one by one). Tests: `vitestReporterSource.test.ts`; e2e `vitest-batch`, `vitest-save-during-run`.
  - **Coverage** with Vitest's own provider (`@vitest/coverage-v8` / `-istanbul`): `--coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory=<session>/vitest-coverage/<batch> --coverage.reportOnFailure=true` (`--coverage.all=false` below 4); otherwise one INFO line. `coverage/istanbulCoverage.ts` maps `coverage-final.json` (one manifest per file version, max-merged); rules shared in `coverage/coverageRules.ts`. The source scan falls back to the shipped parser (`utils/babel.ts`). Tests: `istanbulCoverage.test.ts` (`test/vscodeStub.ts`); e2e `vitest-coverage`; `repo-vitest` checks coverage on real repos.
  - **Related tests on save:** `vitest related <src> --run` through the live batch runner (`IBatchRunner.runRelated`, `SessionManager._runRelatedBatch`), with fresh coverage. e2e `vitest-related`.
  - **Discovery:** without the project's Babel, the shipped `@babel/parser` (`out/vendor/`) and a built-in walker. Vitest syntax: `.for(...)`, `.skipIf`, `.runIf`, `suite`, renamed imports, `.extend(…)` fixtures, `test` / `it` from the project's own modules. `bench` stays out. Files the framework lists without static tests are added and filled in by their results (slidev). Tests: `testDiscovery.test.ts`; unplugin 180, slidev 314, vueuse 1568 tests found.
  - e2e fixture `vitest-basic` (Vitest 3.2.4) and `vitest-full-run`, `vitest-scoped-run`, `vitest-debug`; `repo-vitest` on unplugin, slidev, vueuse vs plain Vitest (`vitest-baseline.json`). Harness `plainVitestJson`, `checkMatchesPlainVitest`.
- **Config saves restart the session** (`FrameworkServices.isConfigFile()`, Jest and Vitest). e2e `basic-config-save`.
- **Open Guide** (`liveTestRunner.openGuide`, `views/GuidePanel.ts`): the guide in an editor tab, shipped in the .vsix (`out/guide/guide.html`), nonce CSP; a dev build opens the online guide. Tests: `guidePanel.test.ts`; e2e `guide-open`.
- **Website** `site/index.html` at https://eshandias.github.io/live-test-runner/ (install buttons for the Marketplace and Open VSX, features, screenshots, framework table, FAQ); the guide moves to `/guide/`. SEO: meta, canonical, Open Graph / Twitter, JSON-LD, `site/sitemap.xml`. `pages.yml` publishes from `main` and `release/*`. `package.json` gains `keywords`, `homepage`, `bugs`.
- **Framework feature matrix:** `docs/development/framework-features.md` is the source; `scripts/framework-matrix.js` copies it into the README and guide (`--check`).

### Fixed
- **Coverage totals follow the project's coverage config** (generated files like Vitest's html-reporter bundle, ~14k statements, roughly halved the percentage). `coverage/coverageScope.ts`, `IProjectConfig.coverageScope(root)`: Vitest `coverage.include` / `exclude` (+ `all` below 4); Jest `collectCoverageFrom`, `coveragePathIgnorePatterns`, test, setup and `__mocks__` files (Jest's `shouldInstrument` rules). Untouched files counted only when the config lists files to cover. Fallback rules skip git-ignored files. Globs via bundled `picomatch`.
- **Coverage % / N/M toggle** now updates the totals row and badge.
- Live run timer updates every second; file durations in whole milliseconds.
- Files in top-level `test/`, `tests/`, `__tests__/`, `__mocks__/`, `dist/`, `build/`, `out/`, `coverage/` were measured as source.
- **A file that fails to load shows its reason** (any framework).
- `describe.each([...])(name, fn)` closed the suite early; `.ts` / `.mts` / `.cts` parsed with JSX broke files with generic arrows.
- **Vitest on Windows with an 8.3 short path** (`C:\Users\RUNNER~1\…`) found or ran no tests: `CommandRunner.spawnPath()` and `toSpawnPath()` spell the CLI entry, cwd, `--config`, filters, probe and ▷ Debug the same way.
- `jestCommand` `npx jest` ran `npx jest jest …`; quotes inside test-script tokens (`--project="browser (chromium)"`).
- On Vitest 2 a describe suite was taken for a file.

### Changed
- **"Jest Output" → "Test Output"**: channel **Live Test Runner: Test Output**, command **Show Test Output** (same id `liveTestRunner.showOutput`); lines keep `[jest#N]`.
- **External links** on the website and guide open in a new tab.
- **Guide refresh:** a Vitest section; framework-neutral wording; Debugging describes the Vitest launch; Known issues lists open bugs; matrix Vitest Timeline "⏳ later".
- **Internal: framework decoupling.**
  - `Framework` → `FrameworkId = string` with `FRAMEWORK_IDS` (old name deprecated); `toJestPath` / `fromJestPath` → `toRunnerPath` / `fromRunnerPath` (`RunnerPaths.ts`); `ProjectJestConfig` → `JestProjectConfig` implementing `IProjectConfig`; `PLAIN_RUN_HANG_FACTOR` in `constants.ts`.
  - Abstract `CommandRunner` (`buildArgs({ kind })`, `leadingArgs`, `processLabel`, chunking, kill, coverage); `FrameworkAdapter` gains `outputFileArg`, `parseResult`, `createRunner`; `Executor.runWithJsonCapture(command, outputFileArg)`. Jest command lines pinned by snapshot tests, unchanged.
  - `FrameworkRegistry` (`register`, `unregister`, `get`, `default()`); `FrameworkDetector.detectWithReason()`; an unrecognised project logs one WARN.
  - `IBatchRunner`; `SessionTraceRunner` → `JestBatchRunner`; `FrameworkServices` bundle and `IFrameworkServicesProvider`; `SessionManager` builds no framework classes.
  - Instrumentation split into `shared/` and `jest/` (protocol in `architecture.md`); the transform cache rebuilds once.
  - Adapter conformance suite (`adapterConformance.ts`) for Jest, CRA and Vitest; services `displayName`, `settingsFingerprint()`.
  - `refusingAdapter()`, `UnsupportedFrameworkError` in their own files; `JestRunner` refuses non-Jest projects. Helpers `utils/semver.ts`, `nodeRuntimeVersion()`, `resolvePackageBin()`, `resolvePackageDir()`.

### Tests and CI
- e2e runs against the packed `.vsix` (`LTR_E2E_EXTENSION_DIR`); real-repo matrix `e2e/real-repos.js` (copies, fails if the original changed; Jest monorepo incl. — known: jest-runtime's own tests fail under the session run, also in 2.0.4).
- Workflows use `pnpm/setup@v3`; Actions on current majors (`checkout` v7, `cache` v6, `upload-artifact` v7, Pages `configure-pages` v6, `upload-pages-artifact` v5, `deploy-pages` v5; `.nojekyll` dropped).
- Version 3.0.0 in both `package.json` files.

---

## [2.0.4] - 2026-10-19

### Added
- **Levelled log channel:** "Live Test Runner" is a `LogOutputChannel` (`error` / `warning` / `info` / `debug` / `trace`, timestamps, Output ⚙ → Set Log Level); lines read `[Area] message`.
  - Raw Jest output in its own channel, **Live Test Runner: Jest Output** (ANSI-stripped, line-buffered, `[jest#12]` per process, `──── Run #N · label ────` separators).
  - One summary per run (`Run #N <trigger> — files · passed · failed · skipped · time — failing: …`) and one per discovery.
  - Noise removed: per-batch `[Coverage]` INFO lines, per-file transform lines, the reporter's PASS/FAIL dump, the decoration `console.log`, the timeline `ltr-debug.log` (now Debug level only).
  - Diagnostics added: Jest's stderr tail when a batch returns nothing, a WARN per test file that fails to run, why files fall back to plain Jest, `ENOENT` fixes, one line for dropped coverage.
  - Runner / core logs reach the channel (`createLogger` / `setLogSink`); instrumentation inside Jest writes `[LTR:<level>] msg` to stderr, routed by `Executor` (`LTR_LOG_LEVEL` passed to Jest).
  - Slow vs stuck: `liveReporter.js` writes a `start` record per file; a watchdog WARNs when no file finished for 60 s (repeats every 2 min); an INFO line when an on-save run cancels a batch sharing a file.
  - Repeated lines collapse; lines before the channel exists are buffered.
  - Commands **Show Logs** and **Copy Diagnostic Report** (versions, setup, settings, last 300 log lines → clipboard + untitled Markdown). `Show Raw Output` → `Show Jest Output`.
- **Setting `liveTestRunner.hangTimeoutSeconds`** (default 300): a test running longer is stopped and its file failed with an explanation.
- **Tests:** an end-to-end suite (`e2e/`, real VS Code, fixtures in a path with spaces, test-for-test comparison with plain Jest; `node e2e/run.js --all`), run in CI on Windows, Linux and macOS; unit tests and an ESLint config (`pnpm lint` in PR checks).
- **Release flow:** PR checks (branch rules, tests, version bump on PRs to `main`); `release.yml` (merge to `main` → build, test, publish, tag `vX.Y.Z`, GitHub Release) replaces the tag-triggered publish; `release/*` branches.
- **Docs:** `docs/live-test-runner-guide.html` (user and contributor guide); a Logging section in the developer guide; an audit of 22 issues (symptom, cause, fix, verification).

### Fixed
- **Console logs missing in the Results panel** (Jest's verbose mode for single files empties `testResult.console`): session runs pass `--verbose=false`.
- **Garbled symbols in Output** (multi-byte characters split across chunks): `setEncoding('utf8')`, complete lines only, ANSI stripped.
- **Jest runs without a shell:** Windows ran Jest's `.cmd` shim through `cmd.exe` (paths with spaces failed, `^` stripped, `|` piped). Jest's JS entry (CRA: react-scripts' Jest) runs with `node`; Stop kills the whole tree; combined patterns are grouped (`^(?:a|b)$`).
- **Run lifecycle:** one `run-started` / `run-finished` across overlapping runs; progress totals from the extension (`run-progress`); Stop is final; ⟳ only when Jest starts a file; spinners always cleared; a save no longer cancels the batch running the same file. `pending` / `todo` show as skipped; files the config never runs (`jest --listTests`) show as skipped and are not run.
- **Config loading:** `ProjectJestConfig` reads `jest --showConfig` (CRA: `react-scripts test --showConfig`) once per session — `.ts` / `.mjs` / `.json` configs, function exports, presets, multi-project configs, `--config` / `--resetMocks` / `--env` from the test script. babel-jest fallback via Node lookup (pnpm); CRA transformer options kept.
- **Per-test trace:** context opened from the setup file, so on-save reruns and covering tests work; `setupTests.js` hooks add to the test; no `process.on('exit')` listener per file.
- **Lost results:** stale-suite cleanup removed finished subtrees (vscode-jest showed 165 of 2012 tests); same-name tests no longer collapse; `nameToPattern` understands `$variable` placeholders.
- **Instrumentation errors** no longer fail test files (nested `?.` in call arguments crashed the transform: "Container is falsy"); any error falls back to plain transpiled code.
- **▷ Debug** debugs only its test or suite (Jest's JS entry from the project root, CRA's config, `nameToPattern`, upper-case drive letter).
- **Timeline:** Windows-safe source pattern, `.each` names, no env leak into the extension host, resolved config, CRA's Jest, transformers loaded like Jest (ts-jest recorded nothing).
- **Symlinked roots** (macOS `/var` → `/private/var`): `JestPaths` maps real paths to the editor's spelling. **Windows 8.3 short paths**, junctions and `subst` drives likewise (`realpathSync.native`, case- and slash-insensitive).
- **Jest + Vitest dependencies:** a `vitest` dependency no longer wins over Jest (`@testing-library/jest-dom` ran nothing); `jest.config.cts/.mts/.json` recognised.
- **`__tests__` folders:** default `testFilePatterns` adds `**/__tests__/**/*.*`; files `jest --listTests` reports but discovery missed are added.
- **One file in several Jest projects:** results merged (`mergeFileResults`); a test fails if it failed in any project.
- **Coverage after the first Start:** manifests live next to the persistent transform cache.
- **`--findRelatedTests` reruns:** `ResultParser` reads Jest's `name` field; the stale flag clears when a rerun ends.
- **Faster Start:** the `jest --listTests` answer is cached per project (`RunnableFiles.ts`) until test files, `package.json` / `jest.config.*` or run settings change.
- New test files created after Start run on save. File durations are Jest's start → end time.
- Inline durations sit at the end of the test's line; a line past a shortened file's end is skipped; results without a location keep discovery's line (`.each` → the template's line).
- Smaller fixes: coverage race / O(N²) updates, pattern reruns keep file output, total count and line maps, drive-letter case, `.mjs` / `.cjs` test files, real `fs` when tests mock it, transform cache per project, saves outside the project ignored, per-file node index, summary running count.

### Changed
- Settings: removed unused `showOutputOnFailure`; declared `coverageExclude`.
- Smaller package: `.vscodeignore` (README media served via `--baseContentUrl`): 91 → 34 files, about 150 KB; `LTR_E2E_EXTENSION_DIR` runs e2e against an unpacked `.vsix`.
- Dependencies: Jest 30, `@types/jest` 30, ESLint 10 (flat config, `typescript-eslint` 8), TypeScript 6.0, esbuild 0.28, `@vscode/test-electron` 3; `@types/vscode` and `@types/node` 16 stay matched to VS Code 1.74.
- Tooling: removed the `runner` → `core` dependency (a cycle pnpm 10+ refuses); build approvals in `pnpm-workspace.yaml` (`allowBuilds`); pnpm 12.14.0 via `packageManager`; the e2e launcher finds VS Code ≥ 1.142's `Code` binary on macOS.
- Verified on macOS: every e2e scenario; vscode-jest (49 files / 2012 tests), jest-dom (31 files, two Jest projects) and a CRA app (14 files / 143 tests) match plain Jest test for test.

---

## [2.0.3] - 2026-05-15

### Fixed
- Running tests with optional chaining (e.g. `?.()`).

---

## [2.0.2] - 2026-05-01

### Fixed
- **Code coverage on Windows:** forward / backward slashes and drive-letter case; the Node path finder works on Windows and macOS.

---

## [2.0.1] — 2026-04-23

### Fixed
- **CRA: tests stayed "pending" after a run.** Jest 26 (react-scripts 4) calls the reporter's `onTestResult`, not `onTestFileResult` (Jest 27+); `liveReporter.js` implements both, deduplicated.
- **Noisy raw output:** `sessionTraceTransform.js` no longer writes a debug line per transformed file (resolve / require errors still logged).

---

## [2.0.0] — 2026-04-21

### Added
- **Code coverage.**
  - **Explorer badge** `Stmts X% | Branch X% | Fns X% | Lines X%`, updated after each run (hidden without a session; scan progress while the first scan runs).
  - **Line bars** `▌`: green covered, amber partial, red uncovered, grey not executable; mirrored in the overview ruler.
  - **Hover:** the tests covering a line (status, duration, links to the Results panel and the test file) and which branch arms hit or missed (`then` / `else`, `truthy` / `falsy`, `&&` / `||`, `?.`). More than 5 tests → "Show all N" Quick Pick (`liveTestRunner.showCoveringTests`).
  - **Stale overlay:** a saved file is tinted grey until its rerun brings fresh coverage.
  - **Coverage tab** in the Explorer: project totals and a per-file table (click to open).
  - **Correct totals:** files no test imports are scanned at Start (`SourceCounter`) and count as 0 % (Istanbul's `all: true`).
  - **No extra pass:** counters share the Jest transform; the scan yields every 10 files.
  - How: `sessionTraceTransform.js` adds `__cov` counters and writes a manifest per file (`<tmp>/coverage/manifests/`); `sessionTraceRuntime.js` flushes them as JSONL on exit; `SessionTraceRunner._parseCoverage()` merges workers (counters max-merged across runs). `CoverageDecorationManager` (five decoration types, `before` pseudo-element), `CoverageHoverProvider` (`ExecutionTraceStore.getTestsForLine()`, `ResultStore.findNodeByFullName()`). Commands `liveTestRunner.revealTestInPanel`, `liveTestRunner.openTestFile`.

### Fixed
- **ts-jest:** no counter inside `jest.mock()` factories (hoisted above the `__covF` preamble → `ReferenceError`).
- **Stale after an on-save rerun:** scoped reruns write no counters, so the stale state never cleared; `CoverageStore.clearStale` after `_runTestCases`.

---

## [1.4.0] — 2026-04-19

### Added
- **Persistent discovery cache:** parse results cached per file with its mtime (`globalStorage/EshLabs.live-test-runner/cache/<project>/discovery-cache.json`); a restart re-parses only changed files (800+ files: ~30–60 s → a few seconds).
  - One cache dir per project (`<folderName>-<sha256(workspacePath)[0:8]>`); a `session.lock` with the VS Code PID.
  - LRU rotation at Start: inactive caches evicted oldest first above 500 MB or 10 projects (a single project is never capped). All active and still over → modal "Continue Without Cache" / "Cancel".
- **Clearing the cache:** Shift-click Stop (`stopAndClearCache`), commands **Stop Testing and Clear Cache** and **Clear Cache and Restart Testing**.

### Changed
- Discovery batches: 5 files cold, 25 warm.
- File results batched in 50 ms windows (`batch-file-results`) — no webview freeze when many files finish at once.
- `files-rerunning` renders once; discovery appends rows with a `DocumentFragment`; row selection swaps a class (no full re-render).
- The collapse arrow no longer selects the row (which re-expanded it).
- A panel shown again scrolls to the current selection (`_sendInit` includes it).

### Internal
- `src/cache/DiscoveryCache.ts` (`DiscoveryCache`, `rotateAndCheckCapacity`); `TestDiscoveryService` cache-first (`BATCH_SIZE_COLD = 5`, `BATCH_SIZE_WARM = 25`); `BaseWebviewProvider` buffers `onFileResult` (`_pendingFileResults`, `_flushFileResults()`); `testListLayout.js` `appendFiles()`, `markFilesRunning()`, `setSelected()`.
- `Executor.runWithReporterPolling` reads the reporter's JSONL while Jest runs; `IFrameworkAdapter.applyFileResult`; `SessionTraceRunner.runFiles` replaces `runFile`.

---

## [1.3.0] — 2026-04-14

### Added
- **Dynamic test groups:** `test.each` / loop tests are permanent "template" nodes (kept with zero children); variations attach as results arrive; clicking a variation reruns its template.
- **Multi-session isolation:** each window uses its own `session-<pid>-<timestamp>` temp folder; folders of dead PIDs are pruned at startup (`process.kill(pid, 0)`).

### Changed
- Status bubbles up through every ancestor (nested `describe`s and dynamic groups).
- Gutter icons turn to spinners as a test starts (scoped reruns too) and update at once.
- Line maps managed by `ResultStore` (icons stayed stale after partial runs).

### Internal
- `LTR_TMP_DIR` → `LTR_BASE_TMP_DIR`; components get an injected `_tmpDir` / `_sessionDir`. `ResultStore.cleanupStaleNodes` keeps `template` nodes.

---

## [1.2.0] — 2026-04-14

### Changed
- **Unlimited `describe` nesting:** a recursive `File → Node[]` tree (flat `TestNode` pool with `parentId` / `children`) replaces File → Suite → Test.
- Stable node ids `{filePath}::{suite1}::…::{name}`; dynamic tests use placeholders cleaned up once Jest reports.
- `bubbleUpStatus()` rolls status up in O(depth); `getSummary()` uses an incremental counter (10,000+ tests).
- Any node scopes the Output and Errors columns to its subtree; output is never back-filled.
- Webview renders recursively (`_renderNode()`, collapsed nodes create no DOM).
- `SelectionState`, `IResultObserver`, `IFrameworkAdapter` and `LineMap` (`{ nodeId, fileId }`) use `nodeId`; `testDiscovery.js` returns a nested tree; `TestDiscoveryService._populateSuiteTree()`; `JestAdapter._applyFileResult()` builds the hierarchy from `ancestorTitles`.

### Internal
- `ResultStore` rewritten (`Map<string, TestNode>`, `rootNodeIds`, `makeNodeId()`, `serialiseFile()`); views, decorations, CodeLens, `SessionManager` and `extension.ts` use `nodeId`.

---

## [1.1.1] - 2026-04-13

### Fixed
- Tests not running on large projects.
- Tests not running on Windows.

---

## [1.1.0] — 2026-04-12

### Added
- **Static test discovery on load** (before Start): `testDiscovery.js` walks each test file's AST with the project's `@babel/parser` / `@babel/traverse` (`describe`, `it`, `test`, `.only`, `.skip`, `.each`, `.concurrent`; template literals shown as `"accepts valid severity …"`; no code run).
  - `TestDiscoveryService`: batches of 8 with event-loop yields; files pushed as parsed (`discovery-progress`); a `FileSystemWatcher` on `**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}` adds new files and re-discovers saved ones not running.
  - `○` pending icons and `▶ Run` / `▷ Debug` CodeLens as soon as a file is discovered (CodeLens registered on activate); `◈ Results` after a result.
  - Start shows `⟳ Discovering… N / total` until done; `_sendInit()` carries `isDiscovering`, `discoveryTotal`, `discoveryDone`; the Total ticks up.
  - `ResultStore.fileDiscovered` / `suiteDiscovered` / `testDiscovered` (never overwrite results), `removeFile`; `fileStarted` keeps a discovered tree. `IResultObserver.onDiscoveryStarted` / `Progress` / `Complete`. `DecorationManager` keeps its types between sessions (`clearAll()`, not `dispose()`).
- **Run one test** by name (`--testNamePattern`).
- **Workers scale to the CPU count** (was 3).
- Loading pane while traces are collected; trace progress in the Explorer.
- **Test-level reruns on source save:** only the test cases that ran code from the saved file (one combined `--testNamePattern` per file); suites with shared state rerun whole.
  - `ExecutionTraceStore` from per-test JSONL traces: `traceIndex`, `coverageIndex`, `sourceToTests` (filled by `SessionTraceRunner._partitionAndStore`).
  - `SessionManager._runAffectedBySourceFile`: the trace first, else `CoverageMap` / `jest --findRelatedTests`.

### Changed
- `SessionManager.start()` awaits `TestDiscoveryService.awaitDiscovery()` instead of discovering itself; `onSave` routes source files through `_runAffectedBySourceFile`.
- `testListView.js` / `resultsView.js` handle `discovery-progress`; a `'discovering'` session state.

### Internal
- Trace files are the ground truth; `ExecutionTraceStore` is rebuilt from them and cleared with them on reset.

---

## [1.0.0] — 2026-04-09

### Added
- **Search down to test cases:** only matching suites and tests are shown (a matching suite shows all its tests).
- **State kept across tab switches:** Start / Stop, the live indicator, search, failures-only and folder view.
- **Gutter icons** ✓ / ✗ / ⟳ / ○ on `it()` / `test()` lines; cleared when the session stops.
- **Inline durations** after each test: green < 100 ms, amber 100–500 ms, red > 500 ms.
- **CodeLens** `▶ Run` (the test, or the file without a result), `▷ Debug` (`vscode.debug.startDebugging`, `--runInBand --no-coverage --testNamePattern`), `◈ Results` (focuses and selects the row).
- CodeLens and gutter icons shown only while a session is active.

---

## [0.2.0] — 2026-04-04

### Added
- **Custom Test Explorer** sidebar (file → suite → test) and **Live Test Results** panel (test list, console output, errors).
- Action bar (Start, Stop, Rerun), live watch indicator, summary bar (total / passed / failed, elapsed), failures-only filter, search, Collapse / Expand All, per-row rerun (▶) and open file (↗), colour-coded duration badges (file, suite, test), empty state, run progress line.
- `session-started` / `session-stopped` messages for the UI state.
- Jest auto-detection: standard Jest, CRA / react-scripts, local `node_modules/.bin/jest`.
- `--outputFile` capture (Windows pipe-buffer loss), a stdout JSON fallback for CRA, console output parsed from stderr for CRA.
- Concurrent runner (up to 3 parallel Jest workers).

### Internal
- `JestTestCaseResult.location`; `LineEntry` / `LineMap` in `ResultStore`; `EditorDecorationManager`; `LiveTestCodeLensProvider` (regex line scan); SVG gutter icons in `resources/icons/`.

---

## [0.1.0] — 2026-04-03

### Added
- Initial release.
- **Auto-detection** of the package manager (npm, pnpm, yarn) and the Jest binary.
- **Live runs on save**, results shown as each file finishes; files run in parallel.
- **Test tree** in the VS Code Testing panel (files, suites, tests), with running / ✓ / ✗ states and pass / fail / skip counts per file.
- **Durations** per file and test (files over 3 s yellow, over 10 s red).
- **"Live Test Runner (ANSI)" output channel** with Jest's coloured output and the exact command.
- **Diagnostics:** red squiggles at the failing line, cleared on the next pass.
- **Status bar:** Off / Running… N/M / ✅ N passed / ❌ N failed; click to start.
- Commands: Start Testing, Stop Testing, Run Related Tests (current file), Refresh Tests, Rebuild Map, Clear Diagnostics, Show Output, Select Project Root.

### Known limitations
- **Per-test output not shown on macOS:** clicking a test in VS Code's Test Results panel shows "The test case did not report any output." (`TestRun.appendOutput()` with a `test` behaves inconsistently on macOS); the global run output is complete.
- So no click-to-view output for a passing test; failure messages appear in the Messages tab on every platform.
- **Monorepos are manual:** set the project root with Select Project Root.
- **No coverage** in the UI yet (planned).
- **Windows path edge cases:** Jest normalises paths differently; matching uses `fileResults[0]` and may misbehave with several Jest projects in one config.

---

## Roadmap

### Future
- Coverage overlay (% per file in tree)
- Re-run a single file or single test from the custom tree
- Persistent results across window reloads
- Monorepo multi-root support
