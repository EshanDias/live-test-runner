# Changelog

Repo changelog: one line per change. What users see is in [the extension's changelog](packages/vscode-extension/CHANGELOG.md); the how and why in [docs/development/design](docs/development/design/).

## [3.5.0] - Unreleased

### Added
- AI assistants: 23 `LTR_` tools and 6 ready-made tasks (`src/ai/catalog.ts`) answered from the stores (`src/ai/tools.ts`).
- Copilot gets them as VS Code language-model tools; Cursor and terminal agents through a stdio MCP relay (`out/mcp.js`) and a file mailbox in the session folder.
- **Connect Your AI Assistant** page with setup commands; a stable launcher in the extension's storage folder.
- Failing tests in the Problems list (`FailureDiagnostics`); **Fix with AI** (CodeLens, Errors pane, quick fix).
- Settings `liveTestRunner.ai.bridge`, `ai.allowRuns`, `ai.fixWithAI`, `showFailuresInProblems`.
- `PRIVACY.md`: what an assistant can read and run, and the files the bridge keeps.

### Tooling
- e2e `ai-bridge`, `ai-bridge-vitest`, `ai-bridge-pytest` drive the relay with a scripted MCP client; `noNetwork.test.ts` scans the relay bundle.

## [3.4.1] - 2026-11-13

### Added
- `liveTestRunner.speed` (full / balanced / light) and `liveTestRunner.speedStrict`; the budget adapts to free CPU and memory (`resources.ts`).
- Test processes run below normal priority; another batch waits while memory is low.
- First Start runs the open test files while the framework lists its files.

### Changed
- Coverage per test file, replaced on each rerun (`CoverageStore`); a background refresh reruns files measured before a change.
- Coverage is measured by the framework itself (Jest's provider, Vitest's provider through `vitestCoverageProvider.mjs`, coverage.py), so numbers equal the plain coverage run.
- pytest runs several processes only when the project uses pytest-xdist `-n`.
- Vitest config probe result remembered between sessions.
- `PRIVACY.md`: the extension reads machine load (CPU, memory, its own processes) to size runs; the start cache keeps the Vitest config answer.

### Fixed
- Speed on large projects: Jest transform cache reuse, trace index per test file, panel redraws, Angular batch sizes, pytest plugin (`ltr_pytest.py`: coverage flushes, JSON, folder collection), Vitest coverage conversions, adaptive budget accounting (`oursInWindow`).
- Jest tests using fake timers were stopped as hanging.
- Tests sharing a `describe` variable reran one by one on save.
- Windows: coverage under 8.3 short paths; the budget uses the physical core count.
- Angular coverage lists the same files as `ng test --coverage`.

### Tooling
- `scripts/perf-project.js`, `scripts/perf-measure.js`, e2e `diag-perf` for large-project measurements; every e2e coverage step compares with a plain framework run.
- e2e: nothing a scenario starts outlives it (`e2e/lib/leftovers.js`).

## [3.4.0] - 2026-11-09

### Added
- Angular 21+ (`AngularAdapter`, Vitest through `ng test`).
- Failures on the failing line (`showFailuresInEditor`).
- Update snapshot (modal confirmation, framework's own update flag).
- Copy buttons and Copy for AI (clipboard only).
- `test.todo` and skipped icons; `PRIVACY.md`.

### Fixed
- Vitest batches share one worker budget.
- Instrumented Jest code kept strict mode and `this` in `obj.fn?.()`; correct stack-trace lines.
- ▷ Debug could hang (now `internalConsole`).

### Changed
- No network calls (`noNetwork.test.ts`); minimum VS Code 1.82.

### Tooling
- Security workflow (audit, dependency review, CodeQL); e2e on the minimum VS Code.

## [3.3.0] - 2026-11-07

### Added
- Python monorepos (uv workspaces) and JS + Python in one folder (`projectDiscovery.ts`).
- Coverage tab says when coverage is off and why.
- Open test files run first on Start.

### Fixed
- Coverage bars on every line of a multi-line statement.
- Tests that write many files no longer restart the session or trigger extra runs.
- A Jest batch retries once when a file vanished mid-crawl.

## [3.2.1] - 2026-11-05

### Added
- Files changed outside the editor rerun their tests.
- Clear All Cached Data, Open Cached Data Folder; unused data pruned after 30 days.
- `liveTestRunner.showCoverageInEditor`; settings gear.

### Fixed
- Stop stops everything; Select Project Root writes nothing into the project.

## [3.2.0] - 2026-10-30

### Added
- pytest support (`PytestAdapter`, `ltr_pytest` plugin), `pythonPath`, `pytestArgs`.
- Running count card; Python environment chip.

### Fixed
- Coverage starts at 0 % during the first run.

## [3.1.0] - 2026-10-28

### Added
- Monorepos and multi-root workspaces (project switcher, `maxRunningProjects`).
- Mixed Jest + Vitest projects (`liveTestRunner.frameworks`, `FrameworkRouter`).
- Vitest execution trace (`vitestTrace`); compiled UI frameworks; Jest ESM mode.

### Fixed
- Vitest 3.0 / 3.1 with Vite 6.4; Vitest `outputFile` configs; custom `testMatch` files batched.

## [3.0.0] - 2026-10-22

### Added
- Vitest support (preview); config saves restart the session; Open Guide; website.

### Changed
- Coverage totals follow the project's coverage config; "Jest Output" → "Test Output".

## [2.0.4] - 2026-10-19

### Added
- Levelled logs, Copy Diagnostic Report, `hangTimeoutSeconds`.

### Fixed
- Jest runs without a shell; TS / ESM Jest configs; lost results; Debug on Windows / CRA; symlinked roots.

## [2.0.3] - 2026-05-15
- Fixed: optional chaining in instrumented code.

## [2.0.2] - 2026-05-01
- Fixed: coverage paths on Windows.

## [2.0.1] - 2026-04-23
- Fixed: CRA (Jest 26) reporter; noisy transform output.

## [2.0.0] - 2026-04-21
- Added: code coverage (totals, line bars, covering tests on hover, Coverage tab).

## [1.4.0] - 2026-04-19
- Added: persistent discovery cache, streaming results, fewer Jest processes, clear-cache commands.

## [1.3.0] - 2026-04-14
- Added: dynamic test groups (`test.each`); per-window session folders.

## [1.2.0] - 2026-04-14
- Changed: unlimited `describe` nesting; virtualised tree.

## [1.1.1] - 2026-04-13
- Fixed: runs on large projects and on Windows.

## [1.1.0] - 2026-04-12
- Added: static discovery on load, run one test, test-level reruns on save.

## [1.0.0] - 2026-04-09
- Added: search, gutter icons, inline durations, CodeLens.

## [0.2.0] - 2026-04-04
- Added: custom Test Explorer and Results panel.

## [0.1.0] - 2026-04-03
- Initial release.
