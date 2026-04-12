# Changelog

All notable changes to Live Test Runner are documented here.

---

## [1.3.0] — 2026-04-12

### Smart On-Save Reruns & Execution Trace Store

#### Added
- **Test-level smart reruns on source file save** — when a source file is saved, Live Test Runner now reruns only the specific test cases that actually executed code from that file (not the whole test file). After the first full run, the extension knows exactly which tests touched which source files via the execution trace. Tests in suites without shared state are rerun individually with a single combined `--testNamePattern`; suites with shared state rerun the whole file to keep results correct.
- **`ExecutionTraceStore`** — three in-memory indexes derived from per-test JSONL trace files and rebuilt after each instrumented run:
  - `traceIndex` — maps each test's full name to its `.jsonl` trace file path
  - `coverageIndex` — accumulates every source line executed by any test in the session (foundation for coverage overlay)
  - `sourceToTests` — maps each source file to the test files, suites, and individual test cases that covered it; drives smart on-save reruns
- **`SessionTraceRunner._partitionAndStore`** now populates `sourceToTests` — after each instrumented file run, all source files referenced in trace steps are mapped back to their covering suites and test cases.
- **`SessionManager._runAffectedBySourceFile`** — new method that consults `ExecutionTraceStore` first, falls back to `CoverageMap` / `jest --findRelatedTests` if no trace data is available yet (e.g. before the first full run completes).

#### Changed
- `SessionManager.onSave` source-file branch now routes through `_runAffectedBySourceFile` instead of calling `_adapter.getAffectedTests` directly.
- On-save now runs individual test cases (one Jest invocation per affected file with combined pattern) instead of always rerunning whole test files when trace data is available.

#### Internal
- Trace files remain the ground truth. `ExecutionTraceStore` entries are derived caches — always rebuilt from trace files, never written independently. Clear both together on session reset.

---

## [1.2.0] — 2026-04-10

### Static Test Discovery

#### Added
- **Static test discovery on project load** — the extension now parses every test file's AST immediately on activate (before the user clicks Start Testing). The full file → suite → test tree appears in the sidebar as files are scanned, with accurate line numbers and pending status icons.
- **`testDiscovery.js`** — lightweight AST walker (reuses project's `@babel/parser` + `@babel/traverse`). Extracts `describe`, `it`, `test`, `*.only`, `*.skip`, `*.each`, and `*.concurrent.*` calls. Template literals with interpolations are shown as readable patterns (`"accepts valid severity …"`). No code is executed or injected.
- **`TestDiscoveryService`** — orchestrates discovery on activate and file watching during idle periods. Parses files in batches of 8 with event-loop yields between batches so the extension host stays responsive on large projects (500+ files).
- **Incremental UI updates** — each parsed file is pushed to the webview immediately via `discovery-progress`, so the test list builds up progressively rather than appearing all at once after a full scan.
- **FileSystemWatcher** — monitors `**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}`. New files appear in the tree immediately on create. Existing files are re-discovered on save as long as no run is in progress (status `running` is the only guard — files with prior results are also re-discovered so newly added tests appear straight away).
- **Pending gutter icons** — `○` pending icons appear next to every discovered test line as soon as discovery finishes, before any test is run.
- **`▶ Run` / `▷ Debug` CodeLens on project load** — CodeLensProvider is now registered on extension activate instead of on session start, so run and debug buttons appear above `it`/`test` lines as soon as a file is open.
- **`◈ Results` CodeLens** — unchanged behaviour: only shown after a test has been run and a LineMap entry exists.
- **Discovering… button state** — Start Testing is disabled and shows `⟳ Discovering… N / total` while the initial scan is in progress. Re-enabled when discovery completes.
- **Race-condition safe init** — `_sendInit()` now carries `isDiscovering`, `discoveryTotal`, and `discoveryDone` fields so webviews that load mid-discovery restore the correct button state and progress counter without depending on message delivery order.
- **Test total counter during discovery** — the summary Total count ticks up as each file is parsed.
- **Three new `ResultStore` methods**: `fileDiscovered`, `suiteDiscovered`, `testDiscovered` — create `pending` entries; all no-op if the entry already exists so live results are never overwritten.
- **`ResultStore.removeFile`** — removes a single file entry and its line map; used by the watcher to force a fresh re-discovery of modified files.
- **`ResultStore.fileStarted` preserves structure** — when a file was pre-populated by discovery, `fileStarted` now preserves the suite/test tree and marks everything `running` instead of recreating with empty suites, so the tree stays visible during a run.
- **`IResultObserver` discovery events** (`onDiscoveryStarted`, `onDiscoveryProgress`, `onDiscoveryComplete`) — optional methods; `BaseWebviewProvider`, `DecorationManager`, and `CodeLensProvider` all implement them.
- **`DecorationManager` no longer disposes on session stop** — decoration types are kept alive between sessions so pending icons from discovery persist; `clearAll()` is called instead of `dispose()`.

#### Changed
- `SessionManager.start()` no longer runs its own file discovery. It awaits `TestDiscoveryService.awaitDiscovery()` (no-op if already done) then reads file paths directly from the store.
- `CodeLensProvider` is registered in `extension.ts` on activate rather than in `SessionManager.start()`.
- `testListView.js` and `resultsView.js` both handle `discovery-progress` to update the test list incrementally.
- `testListView.js` `applySessionState` now supports a `'discovering'` state that disables Start Testing and shows a file progress counter.

---

## [1.1.0] — 2026-04-09

### Test Timeline Debugger

#### Added
- **Test Timeline Debugger** — step-by-step replay of individual test cases. Click `⏱ Timeline` above any `it()` or `test()` line, or the `⏱` button on a test row in the sidebar, to run an instrumented trace and replay execution in the Results panel.
- **`⏱ Timeline` CodeLens** on `it`/`test` lines alongside the existing `▶ Run` and `▷ Debug` lenses.
- **Timeline button** per test row in the Explorer sidebar.
- **Timeline bar** — one box per executed step, colour-coded (accent = active, red = error step, striped = loop compression). Drag to scrub; scroll to zoom between line / function / file grouping.
- **Playback controls** — `⏮ ◀ ▶ ▶| ⏭ ⏸` centred below the timeline bar.
- **Editor highlight** — active step line highlighted in the editor; file switches automatically when steps cross file boundaries.
- **Inline variable ghost text** — variable values rendered as after-text on the active step's line, updating on every step change.
- **Hover tooltip** — hovering a variable line shows value history across steps with `[Add to Watch]` and `[Copy]` actions.
- **Console panel** — cumulative logs up to the current step, prefixed with step number.
- **Errors panel** — all test failure messages, shown statically from the trace result.
- **State panel** (sidebar) — variables at the current step; objects and arrays lazily expandable.
- **Watch panel** (sidebar) — pin variables by name; values track the current step.
- **Call Stack panel** (sidebar) — current step's function and file; clickable to open that location.
- **Re-run button** (sidebar) — re-runs the instrumented trace for the same test without leaving timeline mode.
- **`IInstrumentedRunner` interface** — framework-agnostic contract for instrumented runs; enables future Vitest / Mocha timeline support as a single new file.

---

## [1.0.0] — 2026-04-09

### Test List Improvements

#### Features
- **Search filters to test case level** — typing in the search bar now narrows results down to
  individual test cases. Only matching suites and tests are shown within each file; if a suite name
  matches the query all of its tests are shown, otherwise only the matching tests appear
- **State preserved across tab switches** — the Start / Stop buttons, live blinking indicator, and
  watch state are now correctly restored when returning to the explorer after switching VS Code tabs.
  Search query, failures-only filter, and folder-view toggle also survive the tab switch
- **Gutter status icons** — pass ✓ / fail ✗ / running ⟳ / pending ○ icons appear next to each
  `it()` and `test()` line as soon as results arrive; cleared automatically when the session stops
- **Inline duration text** — muted duration label rendered after the closing paren of each test
  block, colour-coded green (< 100 ms) / amber (100–500 ms) / red (> 500 ms)
- **CodeLens run button** — `▶ Run` appears above each `describe`, `it`, and `test` block while a
  session is active; clicking reruns that test (or the whole file if no result exists yet)
- **CodeLens debug button** — `▷ Debug` above each block launches Jest in debug mode via
  `vscode.debug.startDebugging` with `--runInBand --no-coverage`, scoped to that test via
  `--testNamePattern`
- **Jump to results** — `◈ Results` CodeLens on `it`/`test` lines with known results; clicking
  focuses the Test Results panel and scrolls to and selects the matching row
- **Session-scoped** — CodeLens entries and gutter decorations are only visible while a session is
  active; stopping clears everything immediately

---

## [0.2.0] — 2026-04-04

### Editor Inline Decorations

#### Features
- **Custom Test Explorer** sidebar panel with file → suite → test hierarchy
- **Live Test Results** panel (3 columns: test list, console output, errors)
- **Action bar** — Start Testing, Stop Testing, and Rerun Tests buttons
- **Live watch indicator** shown when the session is active
- **Summary bar** — total / passed / failed counts with elapsed time
- **Failures-only filter** toggle on the test list toolbar
- **Search** bar to filter the test tree by name
- **Collapse All / Expand All** toolbar buttons
- **Per-row rerun** (▶) and **open file** (↗) buttons on hover
- **Duration badges** — color-coded fast / moderate / slow at file, suite, and test level
- **Empty state** message when no tests have been discovered yet
- **Run progress** line showing file count and elapsed time during a run
- `session-started` / `session-stopped` broadcast messages for accurate UI state
- Smart Jest auto-detection: standard Jest, CRA / react-scripts, local `node_modules/.bin/jest`
- `--outputFile` temp-file capture to avoid Windows pipe-buffering data loss
- `stdout` JSON fallback for CRA runs that skip writing `--outputFile` on failure
- Concurrent file runner (up to 3 parallel Jest workers)
- Console output parsed from stderr for CRA projects that omit the `console` array in JSON

#### Internal
- `JestTestCaseResult` now carries an optional `location: { line, column }` field populated from
  Jest's `--json` output
- New `LineEntry` type and `LineMap` methods added to `ResultStore`
- New `EditorDecorationManager` class owns all `TextEditorDecorationType` instances
- New `LiveTestCodeLensProvider` class provides CodeLens via regex line scan (no AST)
- SVG gutter icons in `resources/icons/` (passed / failed / running / pending)

---

## [0.1.0] — 2026-04-03

### Initial release

#### Features
- **Auto-detection** — automatically discovers the package manager (npm, pnpm, yarn) and Jest
  binary used by the workspace; no configuration required for standard setups
- **Live test execution** — runs Jest tests on file save and surfaces results in real time without
  waiting for the full run to finish
- **Test hierarchy in sidebar** — the VS Code Testing panel shows files, describe suites, and
  individual test cases as a collapsible tree, updated live as each file finishes
- **Status indicators** — spinning indicator while a file is running; ✓ / ✗ icons with green/red
  colouring once results arrive; pass/fail/skip counts shown at the file level
- **Durations** — per-file and per-test durations displayed inline; files taking over 3 s are
  highlighted in yellow, over 10 s in red
- **Concurrent execution** — test files run in parallel (up to the worker pool limit); the sidebar
  updates file-by-file rather than waiting for the entire suite
- **ANSI output channel** — a dedicated "Live Test Runner (ANSI)" output channel shows full Jest
  output with colours, including startup logs and the exact command invoked
- **Diagnostics** — failed tests produce red squiggles in the editor at the failing line; cleared
  automatically on the next passing run
- **Project root selection** — command to manually select the project root when auto-detection is
  insufficient (useful for monorepos)
- **Status bar** — shows current state (Off / Running… N/M / ✅ N passed / ❌ N failed) with a
  click-to-start shortcut
- **Commands**: Start Testing, Stop Testing, Run Related Tests (current file), Refresh Tests,
  Rebuild Map, Clear Diagnostics, Show Output, Select Project Root

#### Known Limitations & Bugs

- **Per-test output not shown on macOS** — clicking an individual test case in the VS Code Test
  Results panel shows *"The test case did not report any output."* on macOS. The global run output
  (visible via the "Show Results Output" button) is complete and unaffected. This is caused by
  inconsistent behaviour in the VS Code `TestRun.appendOutput()` API on macOS when a `test`
  parameter is supplied.

- **No per-test click-to-view output** — as a consequence of the above, there is currently no way
  to click a passing test and see its isolated output. Failure messages for failed tests do appear
  in the Messages tab of the Test Results panel on all platforms.

- **Monorepo support is manual** — in workspaces with multiple Jest configs the correct project
  root must be set manually via the "Select Project Root" command.

- **No coverage support** — code coverage is not yet surfaced in the UI. Planned for a future
  release.

- **Windows path edge cases** — Jest normalises file paths differently on Windows; path matching
  uses `fileResults[0]` as a workaround and may behave unexpectedly in edge cases with multiple
  Jest projects in a single config.

---

## Roadmap

### Future
- Coverage overlay (% per file in tree)
- Re-run a single file or single test from the custom tree
- Persistent results across window reloads
- Monorepo multi-root support
