# Changelog

All notable changes to Live Test Runner are documented here.

## [1.5.0] — 2026-04-21

### Code Coverage

#### What's new

- **Live coverage badge** — the Explorer sidebar now shows a four-metric coverage badge (`Stmts X% | Branch X% | Fns X% | Lines X%`) that updates automatically after each test run. Hidden when no session is active; shows a scanning progress indicator while the initial source scan runs.
- **Coverage line decorations** — source lines are marked with a coloured `▌` bar: green (covered), amber (partial branch coverage), red (not covered), grey (non-executable). The overview ruler mirrors the same states so you can navigate uncovered regions from the scrollbar.
- **Coverage hover** — hovering any decorated source line shows: which tests cover it (with pass/fail status and duration), and for partially-covered branches, which arms hit or missed (`then`/`else`, `truthy`/`falsy`, `&&`/`||` leaves, `?.` null vs non-null, etc.). Each test name is a clickable link that reveals the test in the results panel; a file icon opens the test file directly.
- **Stale coverage overlay** — when you save a source file and a rerun is pending, the entire file gets a grey background tint until the rerun completes and fresh coverage data arrives.
- **Coverage Explorer tab** — the Explorer sidebar gains a second tab ("Coverage") showing project-level totals (Stmts / Branch / Fns / Lines) and a scrollable per-file breakdown. Click any file row to open it in the editor.
- **Correct coverage denominators** — source files that no test ever imports are scanned in the background at session start (`SourceCounter`) and included as 0% in the aggregate totals. This matches Istanbul's `all: true` behaviour — no more inflated percentages.
- **No performance impact** — coverage instrumentation shares the existing Jest transform pass (no second AST walk, no extra process). The background source scan yields to the event loop every 10 files to keep the UI responsive.

#### Technical details

- `sessionTraceTransform.js` now injects `__cov` statement/branch/function counters alongside the existing `__strace.step()` calls, and writes a per-file coverage manifest (JSON) to `<tmp>/coverage/manifests/`.
- `sessionTraceRuntime.js` flushes `globalThis.__cov` as a JSONL line to `COVERAGE_OUTPUT_FILE` on `process.exit`.
- `SessionTraceRunner._parseCoverage()` reads the JSONL, merges multi-worker counters, reads manifests, and promotes `CoverageStore` entries.
- Cross-run counter merging uses `max()` — re-running a subset of tests never reduces previously measured coverage.
- `CoverageDecorationManager` applies the `▌` bar via VS Code's `before` pseudo-element decoration (`contentText: '▌'`) so breakpoint gutters are never blocked. Five decoration types: covered, partial, uncovered, neutral, stale.
- `CoverageHoverProvider` is a `vscode.HoverProvider` registered for all JS/TS files. It reads the manifest and counters from the `CoverageStore` entry for the hovered file and line, then cross-references `ExecutionTraceStore.getTestsForLine()` + `ResultStore.findNodeByFullName()` for live status and duration.
- Two new commands wired for hover links: `liveTestRunner.revealTestInPanel` (reveals the test row in the Results panel) and `liveTestRunner.openTestFile` (opens the test file at the relevant test).
- **Bug fix (ts-jest):** `sessionTraceTransform.js` no longer injects `__covF.f["f0"]++` inside `jest.mock()` factory arrow functions. Babel's `jest-hoist` plugin hoists `jest.mock()` to the top of the file — before the `__covF` preamble — so any counter access inside the factory caused a `ReferenceError`. The fix detects this pattern and skips counter injection for mock factory functions.
- **Bug fix (stale after on-save rerun):** scoped reruns (individual test cases via `--testNamePattern`) do not produce a new coverage counters file, so `_parseCoverage` was never called and the `measured-stale` state was never cleared. Fixed by calling `CoverageStore.clearStale(sourceFilePath)` after `_runTestCases` completes in `_runAffectedBySourceFile`.
- **"Show all covering tests" Quick Pick** — when a line is covered by more than 5 tests, the hover now shows a "Show all N" link that opens a VS Code Quick Pick listing every covering test with pass/fail icon and file name. Selecting a test reveals it in the Results panel. New command: `liveTestRunner.showCoveringTests`.

---

## [1.4.0] — 2026-04-19

### Persistent Discovery Cache, Batch Execution & UI Performance

#### Added
- **Persistent discovery cache** — Babel AST parse results are now cached per file alongside mtime in `~/.../globalStorage/EshLabs.live-test-runner/cache/<project>/discovery-cache.json`. On restart, only files whose mtime has changed are re-parsed; everything else loads from cache. Large projects (800+ files) drop from ~30–60 s cold parse to a few seconds on warm restart.
- **Project-keyed cache directories** — each project gets its own cache dir keyed by `<folderName>-<sha256(workspacePath)[0:8]>`. Different projects with the same folder name never collide.
- **Session lock files** — a `session.lock` file containing the current VS Code PID is written on activation and deleted on deactivate. Cache rotation uses PID liveness checks to skip active sessions.
- **LRU cache rotation** — at Start Testing time, inactive project caches are evicted oldest-first when total cache size exceeds 500 MB or more than 10 projects are cached. Single-project installs are never capped.
- **Over-cap warning** — if all cached projects are active and the total still exceeds limits, a modal offers "Continue Without Cache" (runs exactly as before, no data lost) or "Cancel".
- **Shift+Stop to clear cache** — Shift-clicking the Stop button in either the sidebar or panel sends `stopAndClearCache`: stops the session and wipes this project's disk cache. In-memory state (test tree, results) is unaffected.
- **"Clear Cache and Restart Testing" command** — palette command that wipes the current project's cache and immediately restarts discovery + testing from scratch.
- **"Stop Testing and Clear Cache" command** — palette equivalent of Shift+Stop.

#### Changed
- **Discovery batch size adapts to cache warmth** — cold pass (no cache): 5 files per batch (unchanged, keeps UI progressive). Warm pass (cache present): 25 files per batch, reducing event-loop round-trips ~5× for large projects.
- **`onFileResult` messages batched** — file result postMessages are now collected in a 50 ms window and flushed as a single `batch-file-results` message instead of one message per file. Eliminates the webview freeze that occurred when dozens of files completed simultaneously.
- **`files-rerunning` renders once** — marking N files as running now updates all in memory and renders the test list once, rather than once per file (was O(N) full re-renders).
- **Discovery appends to DOM incrementally** — during discovery, new file rows are appended to the list using a `DocumentFragment` per batch instead of triggering a full list re-render per file. Fixes the slowdown / freeze that appeared as the list approached 200–800 files.
- **Row selection uses targeted DOM update** — clicking a test row now swaps the `selected` CSS class in-place instead of re-rendering the entire list. Full re-render only happens when ancestor nodes need to be structurally expanded.
- **Collapse toggle no longer triggers selection** — clicking the ▶ arrow to collapse/expand a row no longer fires a `select` message, which previously caused `scope-changed` → `_expandAncestors` to immediately re-expand the collapsed item.
- **Cross-panel selection restored on visibility** — `_sendInit` now includes the current selection. When either panel becomes visible after being hidden, it scrolls to the previously selected row.

#### Internal
- `src/cache/DiscoveryCache.ts` — new file: `DiscoveryCache` class + `rotateAndCheckCapacity` function
- `TestDiscoveryService` — accepts optional `DiscoveryCache`; cache-first in `_populateFile`; `BATCH_SIZE_COLD = 5`, `BATCH_SIZE_WARM = 25`
- `BaseWebviewProvider` — `onFileResult` now buffers into `_pendingFileResults`; flushes via `_flushFileResults()` after 50 ms
- `testListLayout.js` — `appendFiles()` for O(1) per-batch DOM appends during discovery; `markFilesRunning()` for single-render batch running state; `setSelected()` targeted class swap
- `Executor.runWithReporterPolling` — new method that polls a reporter JSONL file while a Jest child process runs, calling a callback for each parsed record.
- `IFrameworkAdapter.applyFileResult` — new interface method; `JestAdapter` exposes the existing `_applyFileResult` logic publicly so `SessionTraceRunner` can apply liveReporter records into the store without bypassing the adapter.
- `SessionTraceRunner.runFiles` replaces the old `runFile` (per-file trace) method entirely.

---

## [1.3.0] — 2026-04-14

### Dynamic Test Groups & Multi-Session Isolation

#### Added
- **Persistent dynamic anchors** — parameterized tests (`test.each`, loops) are now elevated to permanent "template" nodes in the sidebar. They remain visible as structural anchors even if they temporarily have zero children.
- **Lazy variation attachment** — dynamic test variations are attached as children to their parent templates in real-time as Jest emits results.
- **Multi-session isolation** — each VSCode window now uses a unique `session-<pid>-<timestamp>` temporary directory. This prevents concurrent windows from deleting or overwriting each other's temporary Jest configs and trace files.
- **Safe stale-data cleanup** — the extension now performs a PID-check on startup (`process.kill(pid, 0)`) to safely prune temporary session folders from previous crashes while leaving active sessions untouched.
- **Command pivoting** — clicking a dynamic variation in the sidebar now correctly reruns the parent template, ensuring that the full parameterized suite is executed.

#### Changed
- **Recursive status bubbling** — finalized the "nested branch compatibility." Status changes (pass/fail/running) deep in the tree correctly bubble up through all ancestors, including complex nested `describe` blocks and dynamic groups.
- **Real-time gutter synchronization** — gutter icons now flip to spinners the moment a test starts (even in scoped reruns) and update to their final result state without delay.
- **Unified LineMap management** — moved mapping responsibility into `ResultStore`, eliminating desync bugs where icons wouldn't update after partial test runs.

#### Internal
- `LTR_TMP_DIR` renamed to `LTR_BASE_TMP_DIR`; all internal components now use an injected `_tmpDir` or `_sessionDir` path for isolation.
- `ResultStore.cleanupStaleNodes` now explicitly ignores `template` nodes to preserve the structural anchors.

---

## [1.2.0] — 2026-04-14

### Recursive Nested Node Tree

#### Changed
- **Unlimited `describe` nesting** — the test tree now supports deeply nested `describe` blocks (5+, 10+, or more levels). The old rigid File → Suite → Test hierarchy has been replaced with a recursive `File → Node[]` tree. Every suite and test is a `TestNode` in a flat pool with `parentId`/`children` references.
- **Stable node IDs** — node IDs use the convention `{filePath}::{suite1}::…::{name}`. Static discovery and Jest results match automatically without a lookup table. Dynamic tests (`.each`, template literals, loops) use placeholder nodes cleaned up once Jest emits real results.
- **Live status rollup** — `bubbleUpStatus()` propagates worst-case status from any leaf up through all ancestors in O(depth). If one test fails deep in the tree, every parent suite and the file itself show a failure icon in real time.
- **O(1) summary counter** — `getSummary()` uses an incremental running counter instead of scanning all nodes. Safe for 10,000+ tests.
- **Scoped output at any level** — clicking any node in the tree (file, suite at any depth, or individual test) scopes the Output and Errors columns to that subtree. Output is never back-filled from parent scopes.
- **Webview renders recursively** — `testListLayout.js` uses `_renderNode()` for unlimited nesting depth with lazy child rendering (collapsed nodes don't generate DOM).
- **`SelectionState`**, **`IResultObserver`**, and **`IFrameworkAdapter`** interfaces all use `nodeId` instead of `suiteId`/`testId`.
- **`LineMap`** entries are now `{ nodeId, fileId }` instead of `{ suiteId, testId, fileId }`.
- **`testDiscovery.js`** returns a nested suite tree with `children[]` arrays instead of a flat map.
- **`TestDiscoveryService`** recursively walks the discovery tree using `_populateSuiteTree()`.
- **`JestAdapter._applyFileResult()`** builds node hierarchy from `ancestorTitles` and calls `bubbleUpStatus()` after each test result.

#### Internal
- `ResultStore` rewritten: flat `Map<string, TestNode>` pool, `rootNodeIds` per file, `makeNodeId()` helper, `serialiseFile()` for recursive JSON output.
- `DecorationManager`, `CodeLensProvider`, `BaseWebviewProvider`, `ExplorerView`, `ResultsView`, `SessionManager`, and `extension.ts` all updated to use `nodeId` throughout.

---

## [1.1.1] - 2026-04-13
- Fixed tests not running on large projects
- Fiixed tests not running on windows machines

---

## [1.1.0] — 2026-04-12

### Static Test Discovery, Smart On-Save Reruns & Execution Trace Store

#### Added
- **Run individual tests by name pattern** — `▶ Run` on a specific `it`/`test` line now passes `--testNamePattern` to Jest so only that single test case executes, rather than the whole file.
- **Parallel execution scaled to CPU count** — the concurrent file runner now defaults the worker pool size to the number of logical CPUs, replacing the previous hard-coded limit of 3.
- **Loading pane while collecting traces** — the Session panel shows a loading indicator while instrumented trace data is being collected, so there is no blank state between triggering a run and results appearing.
- **Trace tracker in the Explorer sidebar** — the Explorer now surfaces trace collection progress inline alongside the test tree so users can see which files have been traced without switching panels.
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
- **Test-level smart reruns on source file save** — when a source file is saved, Live Test Runner now reruns only the specific test cases that actually executed code from that file (not the whole test file). After the first full run, the extension knows exactly which tests touched which source files via the execution trace. Tests in suites without shared state are rerun individually with a single combined `--testNamePattern`; suites with shared state rerun the whole file to keep results correct.
- **`ExecutionTraceStore`** — three in-memory indexes derived from per-test JSONL trace files and rebuilt after each instrumented run:
  - `traceIndex` — maps each test's full name to its `.jsonl` trace file path
  - `coverageIndex` — accumulates every source line executed by any test in the session (foundation for coverage overlay)
  - `sourceToTests` — maps each source file to the test files, suites, and individual test cases that covered it; drives smart on-save reruns
- **`SessionTraceRunner._partitionAndStore`** now populates `sourceToTests` — after each instrumented file run, all source files referenced in trace steps are mapped back to their covering suites and test cases.
- **`SessionManager._runAffectedBySourceFile`** — new method that consults `ExecutionTraceStore` first, falls back to `CoverageMap` / `jest --findRelatedTests` if no trace data is available yet (e.g. before the first full run completes).

#### Changed
- `SessionManager.start()` no longer runs its own file discovery. It awaits `TestDiscoveryService.awaitDiscovery()` (no-op if already done) then reads file paths directly from the store.
- `CodeLensProvider` is registered in `extension.ts` on activate rather than in `SessionManager.start()`.
- `testListView.js` and `resultsView.js` both handle `discovery-progress` to update the test list incrementally.
- `testListView.js` `applySessionState` now supports a `'discovering'` state that disables Start Testing and shows a file progress counter.
- `SessionManager.onSave` source-file branch now routes through `_runAffectedBySourceFile` instead of calling `_adapter.getAffectedTests` directly.
- On-save now runs individual test cases (one Jest invocation per affected file with combined pattern) instead of always rerunning whole test files when trace data is available.

#### Internal
- Trace files remain the ground truth. `ExecutionTraceStore` entries are derived caches — always rebuilt from trace files, never written independently. Clear both together on session reset.

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
