# Changelog

All notable changes to Live Test Runner are documented here.

## [3.4.1] - Unreleased

### Changed
- **First results sooner on big projects** — on the first Start, the test files open in your editor run while the framework is still listing its files.

### Fixed
- **Coverage stays true while you work** — delete a test or a test file, stop calling a function, add or delete a file: the numbers follow. While tests rerun in the background to update them, the Coverage tab says **Updating coverage…**.
- **Coverage numbers match your own coverage command** — every file shows what `jest --coverage`, `vitest run --coverage` or `coverage run` reports with your settings, including Jest's `coverageProvider: 'v8'`, Vitest 3's v8 provider and files no test loads.
- Tests that share a variable in a `describe` now rerun together when you save, never one by one.
- **Faster Jest runs on big projects** — compiled files are now reused across batches and sessions (a 2,500-file project: first run ~40% faster, the first result twice as fast), and the cache uses a tenth of the disk space.
- **Much faster pytest runs on big projects** — coverage per test file no longer slows each batch down, and VS Code stays responsive while it is worked out.
- Vitest with the execution trace turned off: coverage now follows deleted tests too.
- Angular coverage lists the same files as `ng test --coverage` (no extra files at 0%, and with `coverageInclude` the files no test loads, `app.config.ts` too).
- **Much faster Angular runs on big projects** — a 2,500-file project runs 4× faster (528 s → 124 s) and uses less memory; test processes now stay within your machine's budget.
- **Faster Vitest runs with coverage** — a 500-file project runs about 15% faster; the first Start no longer runs one test process more than your machine's budget allows.

## [3.4.0] - 2026-11-09

### Added
- **Angular support** — Angular 21+ apps and libraries (`ng test`) now run: results, coverage, Debug, Update snapshot. Before, every test showed as failed.
- **Failures on the failing line** — the reason after the line; hover for the full message and **Show diff**.
- **Update snapshot** — hover a snapshot failure; it always asks first.
- **Copy for AI** — copy a failure with the test's code, ready to paste into your assistant. Plus Copy all and visible copy buttons.

### Fixed
- Vitest runs no longer max out the CPU: together they use at most half your cores (a lower `maxWorkers` in your config is kept).
- Jest tests that failed only in Live Test Runner (`"use strict"`, `?.` calls).
- Wrong line numbers in stack traces from your code (Jest).
- ▷ Debug of a Jest / Vitest test could hang. Output is now in the Debug Console.

### Changed
- `test.todo` and skipped tests have their own icons.
- No network calls, no telemetry — see the [privacy policy](https://github.com/EshanDias/live-test-runner/blob/main/PRIVACY.md).
- Needs VS Code 1.82 or newer (was 1.74).

## [3.3.0] - 2026-11-07

### Added
- **Python monorepos** — each uv workspace member with tests is its own project (shared `.venv`); a root that configures pytest itself stays one project. Services with their own `.venv` each run with it.
- **JS and Python in one folder** — Jest or Vitest for JS files, pytest for Python ones, counts split in the status bar. A `.py` save reruns only Python tests, a `.js` / `.ts` save only JS tests. A `backend/` folder with its own pytest config is its own project.
- **The Coverage tab says when coverage is off**, and what to install (`coverage` for pytest, `@vitest/coverage-v8` for Vitest). Tests still run.
- **Open test files run first** on Start; a test file you open during the run runs next.
- **Report a bug or request a feature** with the new forms on [GitHub](https://github.com/EshanDias/live-test-runner/issues/new/choose).

### Changed
- The **Timeline Debugger** is marked as planned; its command no longer appears in the Command Palette.

### Fixed
- Suites that write many files no longer restart testing over and over (since 3.2.1, more than 20 written files looked like a branch switch).
- Tests that write files into your project no longer trigger extra runs.
- Fewer slow fallbacks when tests create and delete files: a batch that failed because a file vanished is retried once.
- Coverage bars on every line of a multi-line statement, not only its first line.

## [3.2.1] - 2026-11-05

### Changed
- **Clearing the cache clears everything** for the project. New **Clear All Cached Data** (every project) and **Open Cached Data Folder**; data unused for 30 days is deleted automatically.
- **Changes from outside the editor rerun tests** (`git pull`, branch switch, code generators), like a save. Changes during a run rerun when it finishes; a branch switch that changes many files reruns everything once.
- **Coverage bars stay out of your way** — on the left edge of each line, not inside your code; they follow your edits (a changed or moved line has none until you save). Hide or show them with the eye button in the editor title (`liveTestRunner.showCoverageInEditor`).
- **Settings gear** in the Test Explorer title bar.

### Fixed
- **Stop really stops** — the timer stops and nothing keeps working in the background.
- **Select Project Root** no longer writes into `.vscode/settings.json` (VS Code remembers it) and always asks first.
- Rerun / Debug Test at Line, Focus Test in Results Panel and Show All Covering Tests work from the Command Palette (they use the cursor).

## [3.2.0] - 2026-10-30

### Added
- **pytest support** — test tree, live results, gutter icons, ▶ Run / ▷ Debug (test, class, parametrized function), reruns on save, coverage and covering tests, as for Jest and Vitest.
  - Runs in your project's own virtual environment (or pick one with **Select Python Interpreter**); nothing installed or written into your project.
  - Each test shows its own output; a source save reruns exactly the tests that use it.
  - Needs pytest 7+ and Python 3.12+; `coverage` for coverage, the Python Debugger extension for Debug.
  - New settings `liveTestRunner.pythonPath`, `liveTestRunner.pytestArgs`.
- **Running card** — a live **Running** count next to Total / Passed / Failed while tests run; click it to see just those.
- **Which Python** — pytest projects show the Python in use (`🐍 Python 3.12.4 · .venv · pytest 9.1.1`); click to pick another. Amber, with the reason, when it can't run the tests.

### Fixed
- Coverage starts at 0 % during the first run (pytest showed 100 %).
- The Running card stays for the whole run instead of blinking out.
- pytest durations in whole milliseconds (the hover showed `302.763ms`).

### Docs
- New demo GIF, a shorter README, and a website slider showing Jest, Vitest and pytest.

## [3.1.0] - 2026-10-28

### Added
- **Vitest: covering tests and precise reruns** — the hover lists the tests that ran each line; a source save reruns only those tests, as with Jest. On by default (`liveTestRunner.vitestTrace`). Needs Vitest 3+ (browser-mode projects run as before); `vitest.workspace` and type-check (`*.test-d.ts`) files supported.
- **Monorepos and multi-root workspaces** — every package with tests is its own project; nothing runs until you start it.
  - A project switcher at the top of the Explorer shows each project's state and counts; the tree, results and status bar follow it, while gutter icons, CodeLens and coverage always show each file's own project.
  - Start / Stop act on the project shown; several can run at once (`liveTestRunner.maxRunningProjects`, default `auto`).
  - A root config covering its packages (Jest `projects`, Vitest `test.projects`) stays one project; Vitest projects are grouped by name.
  - Commands **Select Project** and **Stop All Projects**; `liveTestRunner.projectRoot` / **Select Project Root** pin one folder as before.
- **Jest and Vitest in one project** (with a Jest config and its own `vitest.config.*`) — each file runs with its framework: the config that lists it, else its imports / calls (`vitest` / `vi.` or `@jest/globals` / `jest.`), else Jest with a warning. Decide explicitly with `liveTestRunner.frameworks` (glob → `"jest"` / `"vitest"`). Files grouped by framework; a source save reruns both; coverage shows lines either ran.
- **Any UI framework** — Vue, Svelte, Astro, Marko, MDX and other compiled files: saves rerun their tests, the hover lists covering tests (Vue templates too), coverage counts them (untested components too). File types your Jest config loads (e.g. Angular `.html`) rerun their tests. React, Solid, Preact, Lit, Angular and Qwik were always supported (plain JS / TS).
- **HTML templates and other loaded files** (`templateUrl`, `?raw` imports) rerun the tests that use them, with Jest and Vitest. Type-check tests rerun when a file they check is saved.
- **Jest in ESM mode** — `NODE_OPTIONS=--experimental-vm-modules` in the test script or `node-options` in `.npmrc` is honoured (ESM-only projects, Svelte 4+ with svelte-jester). The log says what to change if a file fails to load as ESM.

### Fixed
- Jest + `@babel/runtime` failed every test file; jest-preset-angular ran untranspiled TypeScript; files with TypeScript generics had no coverage; decorated Angular spec files were missing with Babel 8.
- A test script running Vitest next to a `jest.config` now runs on Vitest, like `npm test`.
- Vitest 3.0 / 3.1 failed to start with recent Vite ("Failed to load custom Reporter").
- Vitest: one test or suite failed with "invalid JSON" when the config sets `outputFile`, and matched nothing on Vitest 1. Your report file is no longer written to.
- **Clear Cache and Restart Testing** restarts testing and refreshes the list at once.
- Files only your custom `testMatch` / `testRegex` names (e.g. `*.jest.js`) ran one by one without coverage; they run in normal batches now.

## [3.0.0] - 2026-10-22

### Added
- **Vitest support (preview)** — test tree, results streaming file by file, gutter icons, ▶ Run / ▷ Debug, saved test file reruns; files outside your Vitest config's include are not run.
  - Coverage with Vitest's own provider (install `@vitest/coverage-v8` if needed).
  - Each test shows its own console output; failures show the expected / received diff and the line; a failing `beforeAll` shows its real error.
  - A saved source file reruns the tests that import it, with fresh coverage.
  - New settings `liveTestRunner.vitestCommand`, `liveTestRunner.vitestIncludeBrowserProjects` (browser-mode projects need real browsers, so they're left out unless on or your test script picks projects).
- **Saving your Jest or Vitest config restarts testing.**
- **Open Guide** command (also online at https://eshandias.github.io/live-test-runner/guide/), and a **new website**: https://eshandias.github.io/live-test-runner/.

### Changed
- The run timer updates every second.
- Files whose tests are generated at runtime are listed with their results.
- Better discovery: `describe.each(...)` tests appear under their suite; TypeScript files with generic arrows are no longer missing.
- A test file that cannot load shows why (its tests fail with the error).
- "Jest Output" is now **Live Test Runner: Test Output** (command **Show Test Output**).

### Fixed
- Durations without decimals (whole milliseconds; seconds and minutes for longer).
- **Coverage totals match `vitest --coverage` / `jest --coverage`** — they follow your coverage config (Vitest `coverage.include` / `exclude`, Jest `collectCoverageFrom` / `coveragePathIgnorePatterns`); generated files no longer drag the percentage down.
- The % / N/M toggle switches the project totals too.
- Files in top-level `test/`, `__tests__/`, `dist/` or `coverage/` folders no longer count as source.
- `liveTestRunner.jestCommand` set to `npx jest` passed "jest" twice.

---

## [2.0.4] - 2026-10-19

### Added
- **Levelled logs** — error / warning / info / debug, filterable (Output ⚙ → Set Log Level); one summary line per run.
- **Separate Jest output** — "Live Test Runner: Jest Output", without colour-code garbage.
- **Copy Diagnostic Report** — everything a bug report needs, in one click.
- **Hanging tests are stopped** after `liveTestRunner.hangTimeoutSeconds` (default 5 min per test) and marked failed with an explanation.

### Fixed
- Console logs always show in the Results panel, including after a single-file rerun.
- No more `�` in the Output panel.
- Windows: folders with spaces work; ▶ Run on names with `^ | &` runs exactly that test.
- Results no longer disappear (`it.each` tables, same-name tests).
- No "finished" while tests run, no endless spinners; **Stop** stops every Jest process.
- Skipped / todo tests show as skipped; files your Jest config never runs (e2e specs, ignored folders) aren't run.
- TypeScript / ESM Jest configs (`jest.config.ts`, `.mjs`, function exports, `--config` in the test script) are used.
- On-save reruns rerun only the tests that use the saved file; the hover shows which tests cover a line.
- ▷ Debug debugs only the chosen test, on Windows and in Create React App too.
- Timeline Debugger works on Windows, for `.each` tests and TypeScript projects.
- Symlinked folders (macOS), junctions and Windows short (`RUNNER~1`) paths run normally (every file showed as skipped).
- Projects that also list Vitest run on Jest instead of "vite is not supported".
- Tests in `__tests__` folders are found; any file your Jest config runs shows in the tree.
- Multi-project Jest configs: a test fails if it failed in any project.
- Coverage stays after restarting testing.
- Durations at the end of the test's line; "go to file" on a generated `.each` test opens the `test.each(...)` line.
- Smaller download (no source code or screenshots in the package).
- Faster restarts (compiled files cached per project; Start doesn't wait for Jest to list files when nothing changed).
- Test files show how long they took.
- New test files run when saved, even if created after Start.
- Coverage no longer stays "stale" after a source save; those reruns update the tree.

---

## [2.0.3] - 2026-05-15

### Fixed
- Running tests with optional chaining (e.g. `?.()`).

---

## [2.0.2] - 2026-05-01

### Fixed
- **Code coverage on Windows** — forward / backward slashes and drive-letter case; the Node path finder works on Windows and macOS.

---

## [2.0.1] — 2026-04-23

### Fixed
- **CRA (react-scripts 4, Jest 26): tests stayed "pending" and files showed as failed** — the reporter used a Jest 27+ API, so no results arrived.
- **Noisy raw output** — the debug line for every transformed file is gone.

---

## [2.0.0] — 2026-04-21

### Added
- **Code coverage.**
  - **Sidebar badge** `Stmts X% | Branch X% | Fns X% | Lines X%`, live as files complete; gone when you stop.
  - **Line bars** `▌`: green covered, amber partial branch, red uncovered, faint grey for non-executable lines.
  - **Hover** — the tests covering a line (status, duration; click to jump to the result) and, for partial branches, which arm was missed (`then` / `else`, `truthy` / `falsy`, …). More than 5 tests → "Show all N" opens a searchable list.
  - **Coverage tab** next to "Tests": project totals and a file list (click to open).
  - **Stale indicator** — a saved file is greyed until its rerun finishes.
  - **Accurate totals** — files no test imports count as 0 %.

### Fixed
- Coverage stayed grey after a single-test rerun.

---

## [1.4.0] — 2026-04-19

### Added
- **Much faster restarts on large projects** — discovery is cached on disk: seconds instead of 30–60 s with hundreds of files.
- **Results stream in as each file finishes.**
- **Faster runs** — test files grouped into fewer Jest processes; the separate trace phase is gone.
- **Shift+Stop clears the cache**; also **Clear Cache and Restart Testing** and **Stop Testing and Clear Cache**.

### Fixed
- UI freezing with 200–800 discovered test files.
- Collapsing a row re-expanded it.
- The selected row wasn't restored when switching panels.

---

## [1.3.0] — 2026-04-14

### Added
- **Parameterized tests** (`test.each`, loops) stay in the tree as groups; their cases fill in as Jest reports; clicking a case reruns the whole group.
- **Several VS Code windows** no longer interfere (each has its own temp folder; leftovers from crashed windows are cleaned up at startup).

### Changed
- Pass / fail / running rolls up through every nesting level.
- Gutter icons turn to spinners the moment a test starts (scoped reruns too) and update at once; no more stale icons after partial runs.

---

## [1.2.0] — 2026-04-14

### Changed
- **Unlimited `describe` nesting** in the tree.
- A failure anywhere shows on every parent suite and the file, live.
- Click any node (file, suite at any depth, test) to scope the Output and Errors columns to it; output is never copied from a parent.
- Large trees stay fast (10,000+ tests; collapsed nodes render nothing).

---

## [1.1.1] - 2026-04-13

### Fixed
- Tests not running on large projects.
- Tests not running on Windows.

---

## [1.1.0] — 2026-04-12

### Added
- **The test tree appears on project load**, before Start: files, suites and tests with line numbers and ○ pending icons, built up as files are scanned (no code run). New and saved test files update it.
- **`▶ Run` / `▷ Debug` above tests as soon as a file is open**; `◈ Results` once a test has run.
- **Run one test** — `▶ Run` on an `it` / `test` runs only that test.
- **Smarter saves** — saving a source file reruns only the tests that ran its code (suites with shared state rerun whole).
- Parallel runs scale to your CPU count (was 3).
- Start shows `⟳ Discovering… N / total` during the first scan; the Total ticks up as files are parsed.
- A loading pane while traces are collected, and trace progress in the Explorer.

---

## [1.0.0] — 2026-04-09

### Added
- **Search down to single tests** (a matching suite shows all its tests).
- **State kept when you switch tabs** — Start / Stop, the live indicator, search, failures-only and folder view.
- **Gutter icons** ✓ / ✗ / ⟳ / ○ on each `it()` / `test()` line.
- **Inline durations** — green < 100 ms, amber 100–500 ms, red > 500 ms.
- **CodeLens** — `▶ Run` (the test, or the file without a result), `▷ Debug` (that test, in band, no coverage), `◈ Results` (jumps to its row).
- CodeLens and icons show only while a session is active.

---

## [0.2.0] — 2026-04-04

### Added
- **Custom Test Explorer** (file → suite → test) and **Live Test Results** panel (test list, console output, errors).
- Start, Stop and Rerun buttons; live indicator; total / passed / failed with elapsed time; failures-only filter; search; Collapse / Expand All; per-row rerun (▶) and open file (↗); colour-coded durations; empty state; run progress.
- Jest auto-detection (standard Jest, CRA / react-scripts, local `node_modules/.bin/jest`).
- Reliable results on Windows and with CRA (result file capture, stdout and stderr fallbacks).
- Up to 3 parallel Jest workers.

---

## [0.1.0] — 2026-04-03

### Added
- Initial release.
- **Auto-detection** of npm / pnpm / yarn and the Jest binary — no configuration.
- **Tests run on save**, results as each file finishes, files in parallel.
- **Test tree** in VS Code's Testing panel with running / ✓ / ✗ states and per-file counts.
- **Durations** per file and test (files over 3 s yellow, over 10 s red).
- **"Live Test Runner (ANSI)" output** with Jest's coloured output and the exact command.
- **Red squiggles** at failing lines, cleared on the next pass.
- **Status bar**: Off / Running… N/M / ✅ N passed / ❌ N failed; click to start.
- Commands: Start Testing, Stop Testing, Run Related Tests (current file), Refresh Tests, Rebuild Map, Clear Diagnostics, Show Output, Select Project Root.

### Known limitations
- **Per-test output not shown on macOS** in VS Code's Test Results panel ("The test case did not report any output."); the global run output is complete. Failure messages appear in the Messages tab on every platform.
- **Monorepos are manual** — pick the root with Select Project Root.
- **No coverage** in the UI yet (planned).
- **Windows path edge cases** with several Jest projects in one config.

---

## Roadmap

### Future
- Coverage overlay (% per file in tree)
- Re-run a single file or single test from the custom tree
- Persistent results across window reloads
- Monorepo multi-root support
