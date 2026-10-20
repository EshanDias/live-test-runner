# Changelog

All notable changes to Live Test Runner are documented here.

## [3.0.0] - Unreleased

### Framework decoupling (Vitest support, phase 1)

- **Neutral naming and open framework ids (task 1.1)** — `Framework` (closed union `'jest' | 'cra' | 'next' | 'vite' | 'unknown'`) is now `FrameworkId = string` with the shipped ids in `FRAMEWORK_IDS`; `Framework` stays as a deprecated alias. `toJestPath` / `fromJestPath` → `toRunnerPath` / `fromRunnerPath` (`resolution/JestPaths.ts` → `RunnerPaths.ts`; old names kept as deprecated aliases for one release). `PLAIN_RUN_HANG_FACTOR` moved from the Jest adapter to the extension's `constants.ts`. `ProjectJestConfig` → `JestProjectConfig` implementing the new `IProjectConfig` interface, which `SessionManager`, `SessionTraceRunner` and `JestInstrumentedRunner` now depend on.
- **Generic runner layer (task 1.2)** — new abstract `CommandRunner` holds everything that is not Jest-specific (adapter per project root, binary / user-command prefix / `--config` / adapter extra args, Windows command-line chunking, file timeout, kill, coverage file); `JestRunner` now only builds Jest's args per run kind (`buildArgs({ kind: 'list' | 'full' | 'files' | 'testCase' | 'related' })`) and parses `--listTests`. `FrameworkAdapter` gains `outputFileArg(file)`, `parseResult(passed, raw, stderr)` and `createRunner(options)` (Jest + CRA: `--outputFile=`, `ResultParser`, `JestRunner`; the Vite stub throws "not supported"). `Executor.runWithJsonCapture(command, outputFileArg)` takes the result-file flag instead of hard-coding `--outputFile`. `emptyRunResult` / `mergeRunResults` moved out of the Jest parser. `FrameworkDetector` builds its adapter list on first use (adapters now import their runners). Snapshot tests pin the Jest command lines — unchanged.
- **"Jest Output" → "Test Output"** — the raw output channel is now **Live Test Runner: Test Output** and the command **Show Test Output** (same id, `liveTestRunner.showOutput`); lines keep their `[jest#N]` tag.

### Tests

- **Real-repository matrix** — `node e2e/real-repos.js [repo… | --all | --fresh]` copies each real Jest project (APFS copy-on-write on macOS), runs the repo scenarios on the copy, and fails if the original repository changed (HEAD, `git status`, newest mtime). Plain-Jest per-file counts and the match result are recorded in `docs/temp_plans/vitest-baseline.json`. Vitest repos are registered for when Vitest support lands.
- **Jest monorepo in the matrix** — `node e2e/real-repos.js jest` now works end to end: the plain-Jest reference runs used spawnSync's 1 MB default buffer, which killed Jest on big projects (exit null, no baseline); `repo-tsjest` picks the source file for the save test from `packages/*` when there is no top-level `src/`, and reports how many files differ. Found BUG-43 (jest-runtime tests fail under the session run — present in 2.0.4 too, open).

### CI

- Workflows use `pnpm/setup@v3` (pnpm from `packageManager`, Node 24, pnpm store cache and install in one step) instead of `pnpm/action-setup` + `actions/setup-node`. The release job keeps the install conditional (`install: false`).

---

## [2.0.4] - 2026-10-19

### Maintenance

- Added PR checks workflow (branch naming/target rules, tests, version-bump check on PRs to `main`).
- Replaced the tag-triggered publish workflow with `release.yml`: merging to `main` builds, tests, publishes, then tags `vX.Y.Z` and creates a GitHub Release.
- Introduced `release/*` branches; documented the branching workflow in `CLAUDE.md` and `docs/developer-guide.md`.

### Logging overhaul

- **Levelled log channel** — "Live Test Runner" is now a VS Code `LogOutputChannel` with real `error` / `warning` / `info` / `debug` / `trace` levels, timestamps and a user-selectable level (Output ⚙ → Set Log Level). Lines read `[Area] message`.
- **Raw Jest output split out** — Jest's own output moved to a separate channel, **Live Test Runner: Jest Output**. It is ANSI-stripped, line-buffered, and each line is tagged with its process (`[jest#12]`) so output from concurrent batches can be told apart. Each run starts with a `──── Run #N · label ────` separator.
- **One summary per run** — `Run #N <trigger> — files · passed · failed · skipped · time — failing: …` replaces scattered start/finish lines. Discovery logs one summary (files, tests, cache hits, parse failures) instead of a "Cache hit" line per file.
- **Noise removed** — about 20 `[Coverage]` INFO lines per batch, the per-file `[LTR-SESSION-TRANSFORM] …` and `[LTR-TRANSFORM] …` lines, the reporter's PASS/FAIL dump (duplicated Jest's output), the `console.log` on every coverage-decoration refresh, and the timeline `ltr-debug.log` written on every run (now only at Debug level).
- **Diagnostics that matter kept or added** — when an instrumented batch returns no results, the warning includes the tail of Jest's stderr. Test files that fail to execute are a WARN with the first error line. The fallback to plain Jest says which files and why. Spawn failures (`ENOENT`) suggest the fix. Coverage drops (missing manifests) are summarised in one line.
- **Runner/core logs now visible** — `@live-test-runner/runner` exposes `createLogger` / `setLogSink`. The extension installs a sink, so runner/core warnings (e.g. the `npx jest` fallback) appear in the log channel instead of only in DevTools. `core` reuses the runner logger.
- **Child-process log protocol** — instrumentation running inside Jest writes `[LTR:<level>] msg` to stderr. `Executor` routes those lines to the log at that level and removes them from captured stderr. `LTR_LOG_LEVEL` is passed to Jest so instrumentation skips debug/trace writes at the default level.
- **Slow vs. stuck diagnostics** — `liveReporter.js` now writes a `start` record when Jest begins a file. `SessionTraceRunner` runs a watchdog: when no file has finished for 60 s it logs a WARN naming the file currently executing and how long it has been on it (repeats every 2 min while stuck). When an on-save run cancels an in-flight batch that shares a file, an INFO line says which batch was cancelled and that its files will be retried.
- **Repeat collapsing and early buffering** — identical consecutive lines collapse into "previous message repeated N more times". Lines logged before the channel exists are buffered and flushed.
- **New commands** — `Live Test Runner: Show Logs`, and `Live Test Runner: Copy Diagnostic Report` (versions, project/Jest setup, settings, last 300 debug+ log lines from an in-memory ring buffer → clipboard + untitled Markdown doc). `Show Raw Output` is renamed `Show Jest Output`.

### Bug Fixes

- **Console logs missing from the Results panel** — Jest enables verbose mode on its own when a single test file runs (and when the config sets `verbose: true`). Verbose mode prints console calls directly and leaves `testResult.console` empty, so single-file reruns (e.g. saving a test file) showed no logs. Session runs now pass `--verbose=false`. Verified against Jest 29: 0 → 2 captured entries.
- **Garbled symbols in the Output panel** — `Executor` decoded each pipe chunk separately, so multi-byte characters (`✓ ✕ ● ›`) split across chunks became `�`. It now uses `setEncoding('utf8')`, emits only complete lines, and strips ANSI codes (the channel's `ansi` language id did not render them).

### Audit fixes (BUG-03 … BUG-35, see `docs/bugs-and-issues.md`)

- **Jest runs without a shell (BUG-03, BUG-08)** — on Windows Jest ran through its `.cmd` shim via `cmd.exe`: every run failed in project paths containing a space, `^` was stripped and `|` piped. Jest's JS entry point is now resolved (CRA: react-scripts' Jest) and run with `node` from PATH; arguments arrive verbatim. Stop kills the whole process tree. Combined name patterns are grouped (`^(?:a|b)$`; `^a|b$` meant "starts with a OR ends with b").
- **Run lifecycle (BUG-15, BUG-23, BUG-24)** — one `run-started`/`run-finished` across overlapping runs (a save during the full suite no longer "finishes" it), progress totals from the extension (`run-progress`), Stop is final (no retry/fallback after it). Files show ⟳ only when Jest starts them; every failure path clears spinners; Stop reverts them. A save no longer cancels the batch running the same file. New setting `liveTestRunner.hangTimeoutSeconds` (default 300): a single test running longer is stopped and its file failed with an explanation. Jest's `pending`/`todo` show as skipped; files the project's config never runs (`jest --listTests`) show as skipped and are not run.
- **Config loading (BUG-07, BUG-12, BUG-20)** — `ProjectJestConfig` reads the project config with `jest --showConfig` (CRA: `react-scripts test --showConfig`) once per session: `jest.config.ts/.mjs/.json`, function exports, presets, multi-project configs and `--config` / `--resetMocks` / `--env` in the test script now apply. babel-jest fallback resolved via Node lookup (pnpm). CRA transformer options kept.
- **Per-test trace (BUG-04, BUG-28, BUG-19)** — the trace context is opened from the setup file (test files are not instrumented), so smart on-save reruns and "covering tests" work; hooks in `setupTests.js` add to the test instead of erasing it; no `process.on('exit')` listener per file.
- **Lost results (BUG-25, BUG-26)** — stale-suite cleanup removed whole subtrees of finished tests when a discovered placeholder (e.g. `it.each` `case $case`) got no result: vscode-jest showed 165 of 2012 tests. Same-name tests no longer collapse into one node (a failure could be hidden). `nameToPattern` understands `$variable` placeholders.
- **Instrumentation errors no longer fail test files (BUG-31)** — an optional chain inside another chain's call arguments (`a?.b?.c().includes(x?.d())`) crashed the session transform ("Container is falsy") and every test file importing that module failed to run. That `?.` is skipped for branch counting; any instrumentation error falls back to the plain transpiled code.
- **Debug (BUG-05, BUG-06)** — ▷ Debug debugs only its test/suite; the launch config uses Jest's JS entry from the project root, CRA's config, `nameToPattern` and an upper-case drive letter.
- **Timeline (BUG-12)** — Windows-safe source pattern, `.each` names, no env leak into the extension host, resolved config, CRA's Jest; transformers loaded like Jest does (ts-jest projects recorded nothing).
- **Smaller fixes** — coverage race / O(N²) updates (BUG-09); pattern reruns keep file output (BUG-10); total test count and line maps (BUG-11); drive-letter case mapping (BUG-13); `.mjs`/`.cjs` test files and `testFilePatterns` (BUG-17); instrumentation uses the real `fs` when tests mock it (BUG-27); transform cache kept per project across sessions (BUG-29); saves outside the project ignored (BUG-30); per-file node index and no full-tree resend on view show (BUG-16); summary running count fixed.
- **Settings (BUG-18)** — removed unused `showOutputOnFailure`; declared `coverageExclude`.
- **Faster Start (BUG-32)** — the `jest --listTests` answer is kept per project (`RunnableFiles.ts`) and reused while no test file, `package.json` / `jest.config.*` or run setting changed; Start waited 20 s for it on copy-requisition.
- **New test files run on save (BUG-33)** — a test file created after Start is checked with Jest again instead of being ignored.
- **`--findRelatedTests` reruns (BUG-34)** — `ResultParser` reads the file path from Jest's `name` field (results were filed under an empty path); the coverage "stale" flag is cleared when any on-save rerun ends.
- **File durations (BUG-35)** — test files show their total time (Jest's start → end) in both test lists; `ResultParser` now prefers that over the sum of test times.

### macOS verification and fixes (BUG-36 … BUG-41)

- **Symlinked project roots (BUG-36)** — Jest resolves symlinks in `rootDir`, so on macOS (`/var` → `/private/var`) and in any project opened through a symlink every listed file looked unknown (all shown skipped), ▷ Debug found no tests and coverage/trace paths never matched. New `JestPaths` (runner) records each root's real path: paths sent to Jest use it, paths read back are mapped to the editor's spelling.
- **Windows 8.3 short paths (BUG-42)** — the same translation now covers Windows: a project opened by a short name (`C:\Users\RUNNER~1\…`, as on GitHub's Windows runners), a junction or a `subst` drive ran nothing ("No files found"). Roots are resolved with `realpathSync.native`, like Jest, and compared case- and slash-insensitively.
- **Jest + Vitest projects (BUG-37)** — a `vitest` dependency no longer wins over a Jest dependency or Jest config (e.g. `@testing-library/jest-dom` ran nothing). `jest.config.cts/.mts/.json` are recognised.
- **`__tests__` folders (BUG-38)** — the default `testFilePatterns` adds `**/__tests__/**/*.*` (Jest's default `testMatch`); on Start, files `jest --listTests` reports but discovery missed are added.
- **One file in several Jest projects (BUG-39)** — results of a file run by more than one project (e.g. `jsdom` + `node`) are merged (`mergeFileResults`): a test fails if it failed in any project. Before, the last report replaced the others and could hide a failure.
- **Coverage after the first Start (BUG-40)** — coverage manifests now live next to the persistent transform cache, named by file path and content; cached transforms wrote none into the new session folder, so coverage was dropped.
- **Tooling (BUG-41)** — removed the unused `runner` → `core` dependency (a cycle pnpm 10+ refuses); build-script approvals moved to `pnpm-workspace.yaml` (`allowBuilds`); pnpm pinned to 12.14.0 via `packageManager`, used by CI through `pnpm/action-setup`. e2e: the launcher finds VS Code ≥ 1.142's `Code` binary on macOS; plain-Jest comparisons keep path case and map symlinks; the real-project scenario handles multi-project configs and checks that no coverage is dropped.
- **Dependencies** — Jest 30, `@types/jest` 30, ESLint 10 with a flat config (`eslint.config.mjs`, `typescript-eslint` 8), TypeScript 6.0, esbuild 0.28, `@vscode/test-electron` 3. `@types/vscode` and the extension's `@types/node` 16 stay matched to the minimum VS Code (1.74). `tsc` over the extension passes again (the logger class returned by `activate()` is exported).
- **Smaller package** — `packages/vscode-extension/.vscodeignore` (from `develop` / `feat/eshan/timeline`, corrected: the webviews load their files from `src/webview`, so that folder is kept) leaves out TypeScript sources, unit tests, source maps, build files and README media (served from GitHub via `--baseContentUrl`): 91 → 34 files, about 150 KB. New e2e option `LTR_E2E_EXTENSION_DIR` runs the suite against an unpacked `.vsix`; it passes.
- **From `feat/eshan/timeline`** — inline durations sit at the end of the test's line, and a line past the end of a shortened file is skipped (it showed at the end of the file). A result without a location keeps the line discovery found, and generated `.each` tests fall back to their template's line, so "go to file" lands on the `test.each(...)` call.
- **Verified on macOS** — every e2e scenario; vscode-jest (49 files / 2012 tests), jest-dom (31 files, two Jest projects) and a CRA app (14 files / 143 tests) match plain Jest test for test.

### Tests

- **End-to-end suite** (`e2e/`): launches a real VS Code with the extension and drives real commands against fixture projects (in a path with spaces) and real repositories, including a test-for-test comparison with plain Jest. `node e2e/run.js --all`.
- **Unit tests** (`packages/*/test`, esbuild transformer) and a root ESLint config; `pnpm lint` added to PR checks (BUG-14).
- **E2E in CI** — a PR-check job runs the e2e suite on Windows, Linux and macOS with a downloaded VS Code. Fixtures encode what the real projects taught: `it.each` `$var` tables, duplicate names, `jest.mock('fs')`, `setupTests.js` hooks, `--resetMocks` in the test script, slow-loading files, nested `?.`, and a Create React App fixture. Every fixture's results are compared with plain Jest.

### Docs

- `docs/bugs-and-issues.md` — full audit: 22 issues with symptom, root cause, fix and verification steps.
- `docs/live-test-runner-guide.html` — navigable user & contributor guide.
- Developer guide: new **Logging** section (levels, scopes, correlation tags, child-process protocol).

---

## [2.0.3] - 2026-05-15

### Bug Fixes

- Fixed issues with running tests with optional chaining. Ex: ?.()

---

## [2.0.2] - 2026-05-01

### Bug Fixes

- **Code Coverage Works on Windows** - Fixed path issues with Forward Backward slashes and capital simple dive letters. Also, Fixed the node path finder to work on both windows and macOS

---

## [2.0.1] — 2026-04-23

### Bug Fixes

- **CRA: tests staying "pending" after run** — `liveReporter.js` only implemented `onTestFileResult` (Jest 27+). In Jest 26 (react-scripts 4 / CRA 4), the reporter method is `onTestResult`. When neither fired, every file landed in the "missing" bucket: files were marked failed at the file level but individual test nodes were never updated, leaving them all as pending. Fixed by implementing both methods with deduplication (Jest 27 calls both; the set guard prevents double-reporting).
- **Noisy raw output** — `sessionTraceTransform.js` was writing a `process.stderr.write` debug line for every file it transformed, flooding the raw output channel. These lines are now removed (resolve/require errors are still logged).

---

## [2.0.0] — 2026-04-21

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
