# Architecture

Live Test Runner is a monorepo of three packages that form a layered system: a runner engine, shared session logic, and a VS Code extension that owns the entire UI.

---

## Why a custom UI?

The VS Code native Test Results panel has a Mac-specific bug where clicking an individual test shows "The test case did not report any output." even when output is appended correctly. This is a VS Code API limitation affecting all Mac versions.

The solution is a fully custom webview UI. This gives cross-platform control over the results experience and enables a Wallaby-style editor integration that the VS Code API cannot support.

---

## Package overview

```
packages/
├── core/              @live-test-runner/core      Session lifecycle + coverage map
├── runner/            @live-test-runner/runner     Framework-agnostic execution engine
└── vscode-extension/  live-test-runner             VS Code extension
```

Dependency direction: `vscode-extension` → `core` → `runner`. The runner has no knowledge of VS Code.

---

## VS Code layout

```
┌──────┬────────────────────────────────────────────┐
│      │                                            │
│  A   │              Editor area                  │
│  c   │    (gutter icons, inline duration,        │
│  t   │     CodeLens ▶ Run  ▷ Debug  ◈ Results)   │
│  i   ├────────────────────────────────────────────│
│  v   │            Panel (bottom)                  │
│  i   │  [ Output ]  [ Test Results ]              │
│  t   │                                            │
│  y   ├────────────────────────────────────────────┤
│      │  Status Bar                                │
└──────┴────────────────────────────────────────────┘
  │  Primary sidebar
  │  Live Test Runner (explorer view)
```

| VS Code zone | What lives there |
|---|---|
| Activity Bar | Beaker icon — opens the Explorer view |
| Primary sidebar | **Explorer view** — recursive file → node tree (unlimited nesting), summary counts, search; switches to **Timeline sidebar** (State / Watch / Call Stack) in timeline mode |
| Panel › Output | **Live Test Runner** — levelled extension log (error / warning / info / debug / trace). **Live Test Runner: Test Output** — raw Jest output, ANSI-stripped, each line tagged `[jest#N]` |
| Panel › Test Results | **Results view** — 3-column scoped view in normal mode; **Timeline view** (bar + controls + console/errors) in timeline mode |
| Editor gutter | Status icons (✓ / ✗ / ⟳ / ○) per test line; active-step highlight in timeline mode |
| Editor inline | Duration text after each test (normal mode); variable ghost text at current step (timeline mode) |
| Editor CodeLens | `▶ Run`, `▷ Debug`, `◈ Results`, `⏱ Timeline` above each block |
| Status Bar | Live summary: `Live Tests: ✅ 12 passed` |

---

## Package: `core`

Owns session lifecycle and the coverage map.

| File | Responsibility |
|------|---|
| `TestSession.ts` | Start, stop, reset a test session |
| `CoverageMap.ts` | `Map<SourcePath, Set<TestPath>>` built from Jest coverage output |
| `SelectionPolicy.ts` | Legacy; minimal use |

**Coverage map:** core's `CoverageMap` (`IFrameworkAdapter.getAffectedTests`) is not consulted by on-save reruns — the execution trace is (Jest, Vitest), then the framework's related run (`jest --findRelatedTests`, `vitest related`).

---

## Package: `runner`

A self-contained, framework-agnostic execution engine. The VS Code layer depends only on the `TestRunner` interface — never on concrete classes.

### Layers

```
JestRunner (orchestrator)
  ├── FrameworkDetector     inspects package.json → picks adapter
  ├── FrameworkAdapter      resolves binary + config per project type
  ├── BinaryResolver        finds jest binary in project node_modules
  ├── Executor              spawns Jest child process, reads --outputFile JSON on exit
  └── ResultParser          normalises JSON → RunResult
```

### Framework adapters

Each adapter implements `FrameworkAdapter` and names itself with a `FrameworkId` — an open string id (`FRAMEWORK_IDS` lists the shipped ones: `jest`, `cra`, `vitest`, `unknown`).

| Method | Purpose |
|--------|---------|
| `detect(projectRoot)` | Returns true if this adapter handles the project |
| `resolveBinary(projectRoot)` | Returns absolute path to the test runner binary |
| `resolveConfig(projectRoot)` | Returns path to a resolved config file, or undefined |
| `getExtraArgs(projectRoot)` | Any extra CLI flags the framework needs |
| `capabilities(projectRoot)` | `FrameworkCapabilities` at the installed version — callers check these, not the framework id |

Current adapters:

| Adapter | Handles | Notes |
|---------|---------|-------|
| `JestAdapter` | Jest, Next.js + Jest | Reads `jest.config.*` or `package.json#jest` directly |
| `CRAAdapter` | Create React App | Runs `--showConfig` once per session to extract the hidden config; cached in memory |
| `VitestAdapter` | Vitest ≥ 3 (older best-effort) | A `vitest` dependency or Vitest config/workspace file, and no Jest dependency/config (BUG-37). Runs `vitest/package.json#bin` (`vitest.mjs`) with node — no `.bin` shim, no npx. Config: `vitest.config.*` > `vite.config.*`. Capabilities per installed major; refuses the editor's built-in Node when it fails Vitest's `engines.node`. Runner: `VitestRunner`. The `test` script's config-relevant flags are passed on, following `nr` / `npm run` / `pnpm` into other scripts (`testScriptVitestArgs`); its `--config` wins over the config files |

Adapters also own how a run is read: `outputFileArg(file)` (the result-file flag the `Executor` appends), `parseResult(...)` (raw JSON → `RunResult`; Jest and CRA use `ResultParser`, Vitest `parseVitestResult` — see the runner README for what differs between Vitest versions) and `createRunner(...)`. The runner layer is `CommandRunner` (generic: binary/config/extra-arg assembly, chunking, kill, coverage) with one subclass per framework that only builds that framework's args per run kind (`JestRunner`, `VitestRunner`). Commands are `[user-command words] [leadingArgs] [--config] [adapter extra args] [buildArgs]` — `leadingArgs` holds a subcommand and its positionals (Vitest `run <files>`; empty for Jest). Each runner refuses another framework's project with `refusingAdapter()` (throws `UnsupportedFrameworkError` when a run starts).

`FrameworkDetector` tries the adapters of a `FrameworkRegistry` (default: CRA 300 → Vitest 200 → Jest 100, highest priority first) and returns the first match; `detectWithReason()` also says why. A project nothing matches falls back to plain Jest with one WARN per project root (`matched: 'unknown'`). `VitestAdapter` only matches when nothing marks the project as Jest (a `jest` dependency or a Jest config), so libraries that test with both run on Jest. `JestRunner` only runs Jest-family adapters (`jest`, `cra`); for any other project it keeps a stand-in adapter that throws `UnsupportedFrameworkError` when a run starts — setting the project root never fails.

### Jest invocation

Two different command shapes are used depending on context:

**How Jest is started.** Always `node <jest/bin/jest.js> …` — Jest's JS entry point resolved from the project (`BinaryResolver.resolveJestEntry`; CRA: the Jest react-scripts depends on), run with `node` from PATH (fallback: the editor's runtime with `ELECTRON_RUN_AS_NODE=1`) and **no shell**, so arguments (paths with spaces, `^…$` patterns, `a|b`) reach Jest verbatim. A shell is used only for a user `jestCommand` / npx, with every argument quoted. `Executor.kill()` ends the whole process tree. File paths are passed with forward slashes and an upper-case drive letter (Jest realpaths `rootDir` and compares case-sensitively).

**Path spelling.** Jest resolves `rootDir` with `realpathSync.native`, so a project opened through a symlink (macOS `/var` → `/private/var`, a symlinked checkout), a Windows 8.3 short name (`RUNNER~1`), a junction or a `subst` drive has two spellings. `runner/src/resolution/RunnerPaths.ts` records each project root's real path: everything sent to Jest uses it (`toJestPathArg`, generated configs' `rootDir`/`roots`, the transform pattern) and everything read back (`--listTests`, JSON results, reporter records, traces, coverage manifests, Timeline steps) is mapped to the editor's spelling with `fromRunnerPath`.

**One file, several Jest projects.** A multi-project config can run the same file more than once (e.g. under `jsdom` and `node`). Jest reports each run; `mergeFileResults` (runner) merges them so a test fails if it failed in any project.

**Batch run — `JestBatchRunner` (initial run + on-save file reruns):**
```sh
node jest.js --watchAll=false --forceExit --no-bail --runTestsByPath <file1> [file2 …] \
     --config <ltr-temp-cfg.js> --cacheDirectory <per-project transform cache> \
     --maxWorkers=1 --testLocationInResults --verbose=false
```
The temp config starts from the project's config **as Jest resolves it** — `JestProjectConfig` runs `jest --showConfig` (CRA: `react-scripts test --showConfig`) once per session, so every config format, preset and multi-project setup works — and layers on `sessionTraceTransform.js` (light trace transform), `ltrCoverageSetup.js` (first `setupFilesAfterEnv` entry: coverage flush, per-test trace context, test heartbeats) and `liveReporter.js` (streaming reporter). Results are polled from the reporter JSONL file every 200 ms while Jest runs — the UI updates per file rather than waiting for the whole batch.

Reported paths are mapped back to the store's own keys. A file shows ⟳ only once Jest starts it (reporter `start` record). The newest run of a file owns it: an older batch still running the same file is not killed, its result for that file is ignored. A single test running longer than `hangTimeoutSeconds` (setup-file heartbeats) stops the batch; that file is failed and the rest retried.

**Run lifecycle — `SessionManager`.** Every run (full suite, save, ▶ Run) registers on start and ends in a `finally`. Overlapping runs share one progress total (`onRunProgress`) and one `onRunFinished`, sent when the last run ends. A session token changes on Start / Stop; work started under an older token stops before its next batch, retry or fallback. At session start `jest --listTests` (the project's own config) decides which discovered files Jest runs — the others are shown as skipped and never run.

#### Transform pipeline — how `sessionTraceTransform.js` works

Every source file passes through a two-stage pipeline before Jest executes it. The order of the two stages depends on what transformer the project uses:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    sessionTraceTransform.js  (Jest transform)           │
│                                                                         │
│  Detect project transformer from jest.config transform map              │
│           │                                                             │
│           ▼                                                             │
│   ┌───────────────────┐         ┌──────────────────────────────┐        │
│   │  Lenient?         │         │  Strict?                     │        │
│   │  (babel-jest,     │         │  (ts-jest, @swc/jest,        │        │
│   │   CRA, default)   │         │   esbuild-jest, …)           │        │
│   └────────┬──────────┘         └──────────────┬───────────────┘        │
│            │                                   │                        │
│   Stage 1  ▼  our Babel AST instrumentation    │  Stage 1               │
│   ┌──────────────────────────────┐             │  Project transformer   │
│   │ Raw TS/JS source             │             │  (TS → clean JS)       │
│   │   → inject __strace.step()  │             ▼                        │
│   │   → inject __covF counters  │  ┌──────────────────────────────┐    │
│   │   → write coverage manifest │  │ Raw TS source                │    │
│   └──────────────┬───────────── ┘  │   → ts-jest / swc runs tsc   │    │
│                  │                 │   → outputs clean CJS/JS      │    │
│   Stage 2        ▼                 └──────────────┬───────────────┘    │
│   Project transformer                             │  Stage 2            │
│   (babel-jest strips TS types)                    ▼  our Babel AST     │
│   ┌──────────────────────────────┐  ┌──────────────────────────────┐   │
│   │ Pre-instrumented TS/JS       │  │ Clean JS output              │   │
│   │   → babel strips types       │  │   → inject __strace.step()   │   │
│   │   → outputs CJS              │  │   → inject __covF counters   │   │
│   └──────────────┬───────────── ┘  │   → write coverage manifest   │   │
│                  │                 └──────────────┬───────────────┘    │
│                  └──────────────┬─────────────────┘                    │
│                                 ▼                                       │
│              prepend: require('sessionTraceRuntime.js')                 │
│                                 │                                       │
└─────────────────────────────────┼───────────────────────────────────────┘
                                  ▼
                      Jest executes instrumented CJS
```

**Why two orders?**
- `babel-jest` (lenient) strips TypeScript types without type-checking, so it tolerates our injected `__strace`/`__covF` globals in the input.
- `ts-jest` / `@swc/jest` (strict) run the real TypeScript compiler, which rejects unknown globals with type errors. They must receive clean source first; we then instrument the plain JS they produce.

**`jest.mock` hoisting guard:** Babel's `jest-hoist` plugin automatically moves every `jest.mock()` call to the top of the file — before the `__covF` preamble that initialises the coverage counter variable. If a `jest.mock()` factory arrow function contains a counter increment (`__covF.f["f0"]++`), it will throw `ReferenceError: __covF is not defined` at runtime. `sessionTraceTransform.js` detects this pattern and skips counter injection for any arrow function that is the direct factory argument of `jest.mock()`.

`--maxWorkers=1` keeps each Jest process single-threaded so batches can run in parallel without competing for CPU.

**Single-test / scoped-rerun — `JestRunner` (CodeLens `▶ Run`, suite/test reruns):**
```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults [--testNamePattern <name>]
```
- `--outputFile=<tmpfile>` — avoids Windows pipe-buffering truncation for large JSON payloads
- Stdout is captured as a fallback — CRA occasionally skips `--outputFile` on bailed runs
- `--no-bail` — collects all failures in a single pass

### CRA-specific behavior

CRA hides its Jest configuration. You cannot pass `--json`, `--outputFile`, or `--no-bail` to `react-scripts test` directly.

`CRAAdapter` solves this:
1. Runs `react-scripts test --showConfig --passWithNoTests` once per session
2. Extracts the embedded Jest config JSON from the output
3. Writes it to a temp file
4. All subsequent runs invoke Jest directly — never `react-scripts` at run time

The extracted config is cached in memory per session and invalidated if `package.json` changes. Transformer options are kept (`[path, options]`), and behaviour flags from the project's `test` script (e.g. `react-scripts test --resetMocks`) are passed on, so runs match `npm test`.

### Result types

These are the normalised types returned by any runner implementation. They are framework-agnostic — a future VitestRunner or MochaRunner produces the same shapes.

```typescript
RunResult
  └── FileRunResult              // per test file
        └── TestCaseRunResult    // per it/test case
              ├── status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped'
              ├── duration?: number
              ├── location?: { line: number, column: number }
              ├── failureMessages: string[]
              └── ancestorTitles: string[]   // suite hierarchy

ConsoleEntry                     // console output per file run
  ├── message: string
  ├── type: string               // 'log' | 'warn' | 'error' | 'info' | 'debug'
  └── origin: string
```

The deprecated aliases `JestJsonResult`, `JestFileResult`, `JestTestCaseResult`, `JestConsoleEntry` remain exported from `packages/runner/src/index.ts` for backward compatibility but are not used in new code.

---

## Package: `vscode-extension`

### Timeline Debugger

A self-contained feature that runs alongside the existing session system. It replays a single test case step by step, showing what lines executed, what variables held at each step, and where things went wrong.

**Activation:** `⏱ Timeline` CodeLens on `it`/`test` lines, or the per-row `⏱ Timeline` button in the Explorer sidebar. Both call `liveTestRunner.openTimelineDebugger(filePath, testFullName)`.

**Architecture:**

```
IInstrumentedRunner (interface)
  └── JestInstrumentedRunner
        ├── Writes temp Jest config that adds traceTransform.js to the transform chain
        ├── Sets TRACE_OUTPUT_FILE env var
        ├── Spawns Jest via Executor (reused as-is)
        └── Reads JSONL trace file → parseEvents() → TimelineStore

traceTransform.js (CJS)
  Injected into Jest's transform chain for the target file only.
  Adds __trace.step(id, line, file, fn) before each statement
  and __trace.var(id, name, value) after assignments.

traceRuntime.js
  Provides __trace.* — writes each event as a JSON line to TRACE_OUTPUT_FILE synchronously.

TimelineStore
  Held in extension host memory. Serialised (Maps → plain objects) before postMessage.
  Contains: steps[], variables{stepId: VariableSnapshot[]}, logs{stepId: LogEntry[]}, errors[]

PlaybackEngine (webview)
  Pure JS class in results.html. Owns currentStepId, play/pause timer, next/prev/jumpTo.
  On each step change, sends { type: 'step-changed' } to the extension host.

TimelineDecorationManager
  Dedicated TextEditorDecorationType (never touches DecorationManager.ts).
  Highlights the active line; renders inline ghost text (variable values).
  Registers a HoverProvider for variable history + [Add to Watch] / [Copy].
```

**Webview routing:** Both `ResultsView` and `ExplorerView` implement an internal JS router. On timeline activation, the extension sends `{ type: 'route', view: 'timeline' }` to `ResultsView` and `{ type: 'route', view: 'timelineSidebar' }` to `ExplorerView`. The router swaps view modules into `<div id="app">` without reloading the page.

**Shared components:** `logPanel.js` and `errorPanel.js` are standalone JS modules used by both `resultsView.js` (normal mode) and `timelineView.js` (timeline mode). They accept a container element and a data payload, and render themselves with no view-specific knowledge.

### Entry point (`extension.ts`)

Creates the views and the `ProjectRegistry`, registers VS Code commands and event handlers, and hands each command to the selected project's (or the file's project's) `SessionManager`. Contains no run logic.

### Projects — monorepos & multi-root workspaces (phase 7)

A window holds one **`ProjectContext`** per test project (`src/project/`). Everything that used to exist once per window is per project:

| Per project (`ProjectContext`) | Shared by the window |
|---|---|
| `ResultStore`, `ExecutionTraceStore`, `CoverageStore` | `SelectionState`, the views, decorations, CodeLens, hover (these resolve each file to its project) |
| `TestDiscoveryService` + `DiscoveryCache` (keyed by root) | Output channels, status bar item |
| framework services (`FrameworkRouter` → Jest / Vitest bundle(s), each with its own batch runner) | Timeline decorations |
| `SessionManager` (fixed `projectRoot`), runnable-files cache entry (keyed by root) | |
| session folder (`session-<pid>-<ts>/p<N>-<name>`; the folder itself when there is one project) | |

**Detection** (runner `framework/projectDiscovery.ts`, pure, unit-tested) — for each VS Code workspace folder:
1. the folder has its own test config (`jest.config.*`, `package.json#jest`, `vitest.config.*` / `vite.config.*` / `vitest.workspace.*`, `react-scripts test`) → **one project at the folder**; its config covers its packages (the `jest` repo's root `projects`, vueuse / slidev `test.projects` — D12);
2. else a monorepo root (`pnpm-workspace.yaml` `packages:`, `package.json#workspaces`) → **one project per workspace package with tests** (a framework dependency, config, or a test script running jest / vitest / react-scripts);
3. else the folder, if a framework is detected there.

Projects inside another project's root are dropped; a single folder with nothing recognised is still the project (plain Jest, as before). `liveTestRunner.projectRoot` pins the window to that one root.

**`ProjectRegistry`** owns the contexts and the *selected* project. Nothing runs automatically (D11): only the selected project's static discovery starts at activation, others on first selection or Start. Each project's `SessionManager` notifies one observer, the project's **`ProjectObserverGate`**: it records the project's live state (session active, discovering) for the switcher row and forwards every event to the window's observers **only while the project is selected**. Switching (`onDidChangeSelection`) rebinds the Explorer and Results views to the new project's stores (`bindProject`) and sends them a fresh `init` (with `running` progress when the project is mid-run). **Editor features are per file, not per selection** (owner decision 2026-10-22): `DecorationManager`, `CodeLensProvider`, `CoverageDecorationManager` and `CoverageHoverProvider` take a `FileStoresResolver` (`editor/FileStores.ts` → `ProjectRegistry.forFile`) and decorate every file from its own project; they are `editorObservers`, to which every project's gate forwards regardless of selection. Opening a file of a not-yet-discovered project starts that project's discovery (nothing runs); CodeLens ▶ Run / ▷ Debug go to the file's project (explicit clicks work without a session). Background projects keep running and rerunning on save (`onDidSaveTextDocument` goes to the file's project). Start / Stop act on the selected project; `liveTestRunner.maxRunningProjects` (`auto` = 2, or 1 with ≤ 4 cores / < 8 GB total memory) caps how many sessions are active at once — Start on one more is refused with a message naming the running projects.

Why one `SessionManager` per project instead of one manager over contexts: the manager's run bookkeeping (`_token` for Stop, `_activeRuns`, progress, save timers, runnable set) is per session by nature. Keeping it per project made the phase a re-wiring (fixed root, a status sink, a gated observer list) instead of a rewrite, and every single-project path is unchanged.

The status bar shows the selected project: `Live Tests: ✅ 12 passed` with one project (unchanged), `Live Tests: web · ✅ 12 passed · 2 running` with several. The Explorer's **switcher row** (`projects` message; only with two or more projects) lists each project with its state (`● running 3/10`, `● live`, `⟳ discovering`) and ✓ / ✗ counts; clicking one runs `liveTestRunner.selectProject`. Files of a Vitest config with several `test.projects` carry `FileResult.group` (Vitest's `projectName` from `vitest list --json`, cached with the runnable list) and the test list groups them under one collapsible row per Vitest project (D12).

### Observer pattern

All result consumers implement `IResultObserver`. After each file result arrives, `SessionManager` calls every registered observer. This decouples the run engine from the UI completely.

```typescript
interface IResultObserver {
  onSessionStart(): void
  onRunStart(filePath: string): void
  onFileResult(result: FileRunResult, store: ResultStore): void
  onSessionStop(): void

  // Optional — discovery events (called by TestDiscoveryService)
  onDiscoveryStarted?(total: number): void
  onDiscoveryProgress?(file: unknown, discovered: number, total: number): void
  onDiscoveryComplete?(): void
}
```

The discovery methods are optional so existing observers don't need to implement them. `TestDiscoveryService` checks for their presence before calling.

Registered observers: `ExplorerView`, `ResultsView`, `DecorationManager`, `CodeLensProvider`, `CoverageDecorationManager`.

### Data store

**`ResultStore`** — the single source of truth for all result data. Uses a **flat node pool** (`Map<string, TestNode>`) for O(1) lookups with tree relationships managed via `parentId`/`children`. Supports unlimited nesting depth.

```
ResultStore
  ├── files: Map<filePath, FileResult>
  │     └── FileResult
  │           ├── filePath, name, status, duration
  │           ├── output: ScopedOutput     ← console lines captured at file level
  │           └── rootNodeIds: string[]    ← top-level nodes in this file
  │
  └── nodes: Map<nodeId, TestNode>         ← flat pool, O(1) lookup
        └── TestNode
              ├── id, type ('suite' | 'test' | 'template')
              ├── name, fullName, status, duration
              ├── parentId: string | null
              ├── children: string[]       ← dynamic variations attached here
              ├── line?: number
              ├── output: ScopedOutput     ← populated only on scoped reruns
              └── failureMessages: string[]
```

Node IDs follow a stable path convention: `{filePath}::{suite1}::…::{name}`. Status rolls up via `bubbleUpStatus()` in O(depth). Summary counter is incremental (O(1)). Empty `template` nodes are ignored by status rollups to prevent ancestors from showing incorrect passed/failed status during partial child execution.

**Nested Branch Compatibility:** The recursive node tree supports arbitrary depth (10+ levels) of `describe` blocks. When a test result arrives deep within a nested branch, the `ResultStore` automatically bubbles the status up the chain. For partial runs (where only a specific nested test is executed), the extension correctly resets the status of every ancestor in the branch to `running` before applying the new result, ensuring that high-level "failed" or "passed" icons don't stick when their children are still in flight.

**`DiscoveryCache`** — persistent on-disk cache for Babel AST parse output. Lives at `globalStorageUri/cache/<folderName>-<sha256(workspacePath)[0:8]>/discovery-cache.json`. Each entry stores `{ mtime, result }` keyed by absolute file path. On load, stale entries (mtime changed or file deleted) are dropped; only changed files are re-parsed. A `session.lock` PID file marks active sessions so LRU rotation skips them.

- Batch size adapts: `BATCH_SIZE_COLD = 5` (no cache, Babel parse per file) vs `BATCH_SIZE_WARM = 25` (cache hits, stat-only check)
- `flush()` is called once after discovery completes and after each watcher re-discovery
- `rotateAndCheckCapacity()` evicts inactive LRU projects when >500 MB or >10 projects
- Single-project installs are never capped; over-cap with all sessions active shows a warning modal

**`ExecutionTraceStore`** — derived indexes built from per-test JSONL trace files. The trace files on disk are the source of truth; these are fast-lookup caches rebuilt after each instrumented run.

```
ExecutionTraceStore
  ├── traceIndex: Map<testId, string>
  │     testId = full test name ("Suite > test") → absolute .jsonl path
  │     Written to a window-unique trace directory within the user's temp storage.
  │     Used by: Timeline Debugger
  │
  ├── coverageIndex: Map<filePath, Set<lineNumber>>
  │     Every source line executed by any test in the session.
  │     Accumulates across runs — never resets mid-session.
  │
  └── sourceToTests: Map<sourceFilePath, SourceTestMapping>
        {
          [testFilePath]: {
            [suiteName]: {
              isSharedVars: boolean    // true → run whole suite when source changes
              sharedVarNames: string[]
              testCases: string[]      // full test names
            }
          }
        }
        Populated by JestBatchRunner after each file run.
        Used by SessionManager._runAffectedBySourceFile() for smart on-save reruns.
```

**`CoverageStore`** — in-memory store for statement/branch/function/line coverage metrics. Lives in `src/coverage/`. Separate from `ExecutionTraceStore` because it has its own lifecycle (populated by `SourceCounter` + `JestBatchRunner._parseCoverage()`).

```
CoverageStore
  entries: Map<filePath, CoverageEntry>
    CoverageEntry is one of:
      { state: 'counted',        statements, branches, functions, lines }
      { state: 'measured',       manifestPath, counters: LiveCov, pct: CoveragePct }
      { state: 'measured-stale', manifestPath, counters: LiveCov, pct: CoveragePct }

  onDidChange: EventEmitter<void>   — fired on any mutation; observers redraw badge + gutter
  _scanComplete: boolean            — set to true when SourceCounter finishes

Key reads:
  getTotals(): CoverageTotals       — one-pass aggregate across all entries; 'counted' entries
                                      contribute denominator only (covered = 0 until measured)
  getFileRows()                     — returns all entries as { filePath, state, pct } rows
                                      for the coverage table; 'counted' rows with all-zero
                                      counts (Babel parse failed) are omitted
  isScanComplete(): boolean         — true once SourceCounter has processed all source files
  isAllMeasured(): boolean          — true once every entry has been promoted from 'counted'

Key writes:
  setCountedEntry(filePath, counts) — called by SourceCounter per source file
  setMeasuredEntry(filePath, data)  — called by JestBatchRunner._parseCoverage()
  markFileStale(filePath)           — 'measured' → 'measured-stale' on save (rerun pending)
  clearStale(filePath)              — 'measured-stale' → 'measured' if rerun is aborted without
                                      completing (e.g. session stopped mid-rerun)
  markScanComplete()                — called by SourceCounter when its scan loop finishes
  clear()                           — full reset on session stop
```

**`CoverageTotals`** — aggregate type returned by `getTotals()`:
```typescript
interface CoverageTotals {
  statements: { covered: number; total: number; pct: number }
  branches:   { covered: number; total: number; pct: number }
  functions:  { covered: number; total: number; pct: number }
  lines:      { covered: number; total: number; pct: number }
  scanComplete: boolean   // mirrors CoverageStore._scanComplete for consumer convenience
}
```

Entry lifecycle:
1. `'counted'` — set by `SourceCounter` at session start (0 hits, denominator only)
2. `'measured'` — promoted by `JestBatchRunner._parseCoverage()` after a run touches the file
3. `'measured-stale'` — set by `SessionManager` when the file is saved and a rerun is pending
4. Back to `'measured'` — when the rerun completes and `_parseCoverage()` fires again

**`CoverageReport`** (`src/coverage/CoverageReport.ts`): Stateless `calculate(manifest, counters): CoveragePct` function. Reads a coverage manifest (statement/branch/function IDs with location) and a live counter snapshot, and returns the four-metric `CoveragePct`. Called by `JestBatchRunner._parseCoverage()` — not a class; no side effects.

**`CoverageDecorationManager`** (`src/editor/CoverageDecorationManager.ts`): Implements `IResultObserver`. Subscribes to `CoverageStore.onDidChange` and refreshes all visible editors on every change. For each editor it reads the `CoverageStore` entry and — for `measured` or `measured-stale` entries — loads the manifest from disk to classify every line into one of four states:

| State | Decoration | Condition |
|-------|-----------|-----------|
| covered | green `▌` bar (before pseudo-element) | statement hit count > 0 and all branch arms hit |
| partial | amber `▌` bar | statement hit > 0 but at least one branch arm missed |
| uncovered | red `▌` bar | statement hit count = 0 |
| neutral | faint grey `▌` bar | line not in any statement (comments, blank lines) |

When the entry is `measured-stale` an additional full-file grey background tint is applied via a `isWholeLine` decoration type. The overview ruler mirrors the green/amber/red states so uncovered regions are visible in the scrollbar minimap. Breakpoint gutters are never blocked because the `▌` character is injected via the `before` pseudo-element, not drawn in the gutter column.

**`CoverageHoverProvider`** (`src/editor/CoverageHoverProvider.ts`): Registered as a `vscode.HoverProvider` for all JS/TS source files. On hover it:

1. Looks up the `CoverageStore` entry for the file; returns nothing if the file has no coverage data.
2. Returns a stale warning if the entry is `measured-stale`.
3. For `measured` entries, reads the manifest to check whether the hovered line is covered and whether any branches on that line have missed arms.
4. Builds a `MarkdownString` with:
   - Branch arm hit/miss table for partial lines (e.g. `if/else: ✓ then / ✗ else`)
   - A list of up to 5 tests that cover the line, each showing pass/fail icon, duration, a clickable link to reveal the test in the Results panel (`liveTestRunner.revealTestInPanel`), and a file-open link (`liveTestRunner.openTestFile`).
5. Test status is read from `ResultStore.findNodeByFullName()` at hover time — never cached — so it always reflects the latest run.

**Coverage Explorer tab** (`src/webview/views/coverageExplorerView.js`): A router view mounted in `explorer.html` when the user clicks the "Coverage" tab. Shows a four-column project totals row (Stmts / Branch / Fns / Lines) and a scrollable per-file breakdown table. Clicking a file row sends an `openFile` message to the extension host, which opens the file in the editor. The tab is only shown when a session is active and coverage data is available.

**Coverage manifest** (`src/session/instrumentation/sessionTraceTransform.js` writes these):
```
<LTR_SESSION_TMP_DIR>/coverage/manifests/<sha256(filePath)[0:16]>.json
```
Written once per source file per transformed run. Contains every statement/branch/function with IDs and line locations. The manifest + counters together drive the four metrics. `CoverageStore` holds only the path string — the file is read on demand (gutter decorations, `_parseCoverage` merging) to keep heap flat on large projects.

**`SourceCounter`** (`src/coverage/SourceCounter.ts`):
Runs at session start in parallel with the first test run. AST-parses the source files that count toward coverage (via `vscode.workspace.findFiles` + `@babel/parser`), counts statements/branches/functions/lines, and populates `CoverageStore` with `'counted'` entries. This ensures untouched files (never imported by any test) still contribute to the denominator — giving correct aggregate percentages rather than inflated ones. Which files count is the framework's **`CoverageScope`** (`src/coverage/coverageScope.ts`, from `IProjectConfig.coverageScope(root)`), so the totals match the CLI report: Vitest's resolved `coverage.include` / `exclude` (read by the runner's config probe), or Jest's `collectCoverageFrom` / `coveragePathIgnorePatterns` / test and setup files (from `--showConfig`). With no include list (no Vitest `coverage.include`, no Jest `collectCoverageFrom`) the CLI reports only loaded files, so the scan is skipped. The same scope filters measured files in both batch runners. When the config cannot be read, the built-in exclusion list (`node_modules`, test files, config files, `dist/`, etc.) applies and git-ignored files are skipped. Yields to the event loop every 10 files (`YIELD_EVERY = 10`) to keep the UI responsive. Emits `progress` and `done` events for the badge scanning indicator. Respects the `liveTestRunner.coverageExclude` setting (array of glob patterns, always excluded from the scan).

**Relationship between the stores:**
- `ResultStore` answers "what happened" — pass/fail, output, failures
- `ExecutionTraceStore` answers "what ran and where" — which lines executed, which tests cover which files
- `CoverageStore` answers "how much is covered" — statement/branch/function/line percentages per file and in aggregate
- The trace files and coverage manifests are the ground truth on disk; the stores are derived caches.

**`LineMap`** — inside `ResultStore`:

```
LineMap: Map<filePath, Map<lineNumber, LineEntry>>
LineEntry: { nodeId, fileId }   // identity only — never status or duration
```

`LineMap` stores identity only. `DecorationManager` always queries `ResultStore.getNode(nodeId)` for status and duration at decoration time — they are never duplicated into the map, so they are never stale.

**LineMap lifecycle:**
1. **Discovery** — `TestDiscoveryService._populateSuiteTree()` builds the initial map from AST line numbers. Gutter icons and CodeLens lenses are available immediately.
2. **Run** — `JestAdapter._applyFileResult()` replaces the map for that file with Jest's authoritative `location.line` values. This is more accurate than AST line numbers (Jest accounts for comments, blank lines, etc.).
3. **Session stop** — `clearAll()` wipes decoration state but the map is retained until the next run or discovery pass. Pending icons from discovery persist across session stop/start cycles.

**`ScopedOutput`:**

```typescript
interface ScopedOutput {
  lines: OutputLine[]       // captured log lines
  capturedAt: number | null // Date.now() when stored; null = never run at this scope
}

interface OutputLine {
  text: string
  level: 'log' | 'info' | 'warn' | 'error'
  timestamp: number
}
```

**Output scoping rules:** Jest JSON reports console output at file level only. When a file runs, only `FileResult.output` is set. Node output is set only when that scope is individually rerun via `--testNamePattern`. Output is never back-filled or fabricated for scopes that haven't been run individually.

Vitest is different: the runner's reporter (`framework/vitestReporter.ts`, loaded with `--reporter=<file>` next to `default` and `json`) records each console call with the task that made it, so `ConsoleEntry.scope` is `file` / `suite` / `test` with the scope's full name. `RunnerBackedAdapter` then sets every touched test's output to exactly its own lines (empty for a quiet test that ran), a suite's to its hooks' lines, and — on a whole-file run — the file's to all lines. Scoped reruns update only the scopes they ran.

**`SelectionState`** — tracks which row the user has selected in the results panel. Emits `scope-changed` messages when selection changes.

### Static test discovery (`TestDiscoveryService`)

Runs on extension activate — before the user clicks Start Testing.

1. **`start(projectRoot, store, log, callbacks)`** — finds all test files via `vscode.workspace.findFiles`, then parses them in batches of 8 with a `setImmediate` yield between batches. This keeps the extension host responsive on large projects (500+ files, 3000+ tests).
2. **Per-file** — reads source, runs `discoverTests()` (AST walker in `testDiscovery.js`), recursively walks the returned suite tree calling `store.nodeStarted` / `store.nodeResult` to build the hierarchical node tree. Rebuilds the `LineMap` for that file, and emits a serialised file object via `onFileDiscovered` callback.
3. **`awaitDiscovery()`** — returns the internal `Promise`; `SessionManager.start()` awaits this so it never re-discovers files that are already populated.
4. **PID Cleanup** — during activation, the service scans the shared temporary root and prunes session folders whose owning process ID is no longer active (verified via `process.kill(pid, 0)`).
4. **`FileSystemWatcher`** — monitors `**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}`. New files appear immediately on create. On change/save the watcher skips files with status `'running'` (a run is already in progress for that file); for all other statuses it calls `store.removeFile()` and re-populates so newly added or renamed tests appear straight away without waiting for a run.

**`testDiscovery.js`** (pure AST walker, no code injection):
- Uses the project's own `@babel/parser` + `@babel/traverse` (lazy-loaded from the project root at first use)
- Handles: `describe` / `it` / `test`, `.only` / `.skip`, `.each([...])(name, fn)` (curried call pattern), `.concurrent.*`, deep `MemberExpression` chains
- Template literals: interleaves quasi text with `…` placeholders so interpolated names still appear in the tree (`"accepts valid severity …"`)
- Returns `{ suites, rootTests }` with accurate `line` numbers for every node

### Session management (`SessionManager`)

1. **Start Testing** — awaits `TestDiscoveryService.awaitDiscovery()` (no-op if discovery already finished), reads file paths directly from `ResultStore`, clears `CoverageStore`, fires `SourceCounter` (background, parallel), runs all test files, enables on-save listener
2. **On save** — debounced (default 300ms); classifies file as test or source; for source files calls `CoverageStore.markFileStale()` then `_runAffectedBySourceFile()` (trace-store driven with CoverageMap fallback)
3. **Stop Testing** — kills child processes, clears decorations, calls `CoverageStore.clear()`, disables on-save

After each file batch, `JestBatchRunner` parses the light-trace JSONL (updates `ExecutionTraceStore`) and then parses the coverage counters JSONL (promotes `CoverageStore` entries from `'counted'` to `'measured'`). Both happen in the same post-Jest-exit phase — no extra process or phase needed.

Concurrency is controlled by a `CONCURRENCY = 3` constant in `SessionManager`.

### Framework adapter layer (extension side)

`IFrameworkAdapter` adds VS Code-specific methods on top of the runner's adapter concept:

| Method | Purpose |
|--------|---------|
| `detect(projectRoot)` | Detect the framework |
| `discoverTests(projectRoot, log)` | Run `--listTests`, return file paths |
| `isTestFile(filePath)` | Classify a saved file |
| `runFile(...)` | Run a file and write to `ResultStore` |
| `runTestCase(...)` | Run a single test by name |
| `getAffectedTests(session, changedFile)` | Test files affected by a source change |
| `getDebugConfig(...)` | VS Code debug launch config for `▷ Debug` |

Adding a new framework = one file implementing `IFrameworkAdapter`, plus that framework's batch runner and project config, bundled as `FrameworkServices`. `SessionManager`, `ResultStore`, all views, and all observers require zero changes.

### Framework services bundle (extension side)

`SessionManager` never builds framework classes. It gets an `IFrameworkServicesProvider` (`servicesFor(fileOrRoot)`, `all()`) and asks it for the `FrameworkServices` of a file or project root (`framework/FrameworkServices.ts`):

| Member | Interface | Jest implementation | Vitest implementation |
|---|---|---|---|
| `adapter` | `IFrameworkAdapter` | `framework/JestAdapter.ts` | `framework/VitestAdapter.ts` |
| `projectConfig` | `IProjectConfig` (`get(root)`, `reset()`) | `session/JestProjectConfig.ts` (`jest --showConfig`) | `session/VitestProjectConfig.ts` (the config file path) |
| `batchRunner` | `IBatchRunner` (`runFiles(BatchRunOptions)`, optional `runRelated(RelatedRunOptions)`, `kill()`, `reset()`) | `session/JestBatchRunner.ts` (results + trace + coverage, streamed) | `session/VitestBatchRunner.ts` (results streamed per file from the runner's Vitest reporter; per-test hang limit + no-progress fallback; Vitest's own coverage → `coverage/istanbulCoverage.ts` → CoverageStore; execution trace through `VitestTrace`'s wrapper config → `traceRecords.ts`) |
| `instrumentedRunner` | `IInstrumentedRunner` (Timeline), optional | `timeline/JestInstrumentedRunner.ts` | — (phase 10) |
| `createSessionRunner()` | runner `TestRunner` for core's `TestSession` | runner `JestAdapter.createRunner()` → `JestRunner` | runner `VitestAdapter.createRunner()` → `VitestRunner` |

Both adapters extend `framework/RunnerBackedAdapter.ts`, which holds everything that only needs a runner's `RunResult`: single-file, test-case and related runs, and mapping `FileRunResult`s into the `ResultStore` (suites, `.each` templates, scoped reruns, output, and a file's own failure — its tests are failed with `failureMessage` when nothing ran). The adapters add detection, their runner (with the user's command setting) and the debug launch config.

Each `ProjectContext` composes its own `FrameworkRouter` (`framework/FrameworkRouter.ts`; one per project, so two projects never share a batch runner). `prepare()` (every Start) detects the root's main framework (runner `FrameworkDetector`) and whether the root is **mixed** (runner `projectFrameworks`: a Jest marker plus a `vitest.config.*` / `vitest.workspace.*` of its own), and reads `liveTestRunner.frameworks`. A single-framework project gets one bundle (`createJestServices` or `createVitestServices`) and lists its files as before. A mixed project (or one where a setting glob sends a discovered file to the other framework) lists with both frameworks in parallel and places every file once — runner `assignFrameworks` (ADR-8):

1. `liveTestRunner.frameworks` (first matching glob);
2. only one framework's list holds the file → that one (also when the other listing failed);
3. both list it → an import from `vitest` / a `vi.` call → Vitest, `@jest/globals` / a `jest.` call → Jest (`frameworkHint`);
4. nothing says → the main framework, one WARN naming the setting (D13).

`servicesFor(file)` then returns the file's bundle (source files and the root: the main framework). The placement is stored with the runnable-files cache (`frameworks: { file: "vitest:hint" }`); placements that came from a file's content are read again on restore and on save (`fileChanged`). Each runner refuses a root detected as the other framework (BUG-37) unless the router called `allowFrameworkAt(root, fw)`. In `SessionManager` batches are queued per framework (never mixed), a source-file save reruns each framework's dependents (`owns` filter: results of the other framework's files are ignored), and any framework's config file restarts the session. A source file loaded by tests of both frameworks gets its coverage merged by line (`coverageRules.combineWithEntry`). The Timeline command goes through a delegating `IInstrumentedRunner` that asks the test file's framework (Vitest: "not available yet"). Stop kills the batch runners of `all()` bundles.

Static discovery (`instrumentation/shared/testDiscovery.js`) uses the project's own `@babel/parser` / `@babel/traverse` when it has them (every Jest project), else `out/vendor/babel-parser.js` (shipped by `esbuild.js`) with a built-in call-expression walker.

### Session instrumentation protocol

The files that run **inside the test process** live in `src/session/instrumentation/` and are copied, with the same layout, to `out/instrumentation/` (they cannot be bundled; the runners pass their absolute paths to the framework):

| Folder | File | Role |
|---|---|---|
| `shared/` | `sessionTraceRuntime.js` | The `__strace` runtime — framework-neutral |
| `shared/` | `testDiscovery.js` | Static AST test discovery (bundled into the extension, not run in the test process) |
| `jest/` | `sessionTraceTransform.js` | Jest transform: Babel-instruments source files with `__strace.step()` calls and `__cov` counters, writes coverage manifests |
| `jest/` | `ltrCoverageSetup.js` | `setupFilesAfterEnv`: opens/closes the trace context around each test, flushes `__cov` on exit, test heartbeats |
| `jest/` | `liveReporter.js` | Reporter: one JSONL record per finished file (`start` record when a file begins) |
| `vitest/` | `vitestTraceConfig.js` | Helper of the wrapper config (`--config`): loads the project's config with its own Vite, adds the plugin to every `test.projects` entry, writes per-project wrappers, reports to `LTR_VITEST_TRACE_MARKER` |
| `vitest/` | `vitestTracePlugin.js` | Vite plugin `live-test-runner:trace`: setup file first in `test.setupFiles`, `server.fs.allow`, `resolveId('vitest')` for the setup file, `enforce: 'post'` transform |
| `shared/` | `sourceMapLookup.js` | Reads a v3 source map back (generated → original line / column; other sources ignored) — Jest and Vitest transforms |
| `vitest/` | `vitestTraceTransform.js` | Pure: parse (`@babel/parser`), splice `globalThis.__strace?.step(L, F)` calls, source map; `withoutTrace()` undoes it |
| `vitest/` | `vitestTraceSetup.mjs` | Setup file: per-test trace context (`beforeAll` / `beforeEach` / `afterEach` / `afterAll`), `F` record, `Function.prototype.toString` without the inserted calls |

Vitest's results come from the runner's reporter (`framework/vitestReporter.ts`) and its coverage from Vitest's own provider; only the trace uses `vitest/` (ADR-9 in the Vitest plan). The contract a framework keeps:

- **`globalThis.__strace`** (defined once per worker by `sessionTraceRuntime.js`): `beginFile(testFile)` — module-level code of the test file starts; `beginTest(name, testFile)` / `endTest(testFile)` — around each test body (between tests the context is `hook`); `enterTest` / `exitTest` / `enterHook(type, testFile)` / `exitHook` — injected wrappers, nest into the open context; `step(line, file)` — instrumented code hit a line; `finish()` — flush the last context. `var()` / `log()` are no-ops here (Timeline only).
- **Trace records** — JSONL appended to `SESSION_TRACE_FILE`, one per test body / hook block: `{"type":"T","tf":"<test file>","tn":"<full test name>","fh":{"<source file>":[lines…]}}` and `{"type":"H","tf":…,"hk":"file"|"hook"|<hook name>,"fh":{…}}`; Vitest's setup adds `{"type":"F","tf":…}` when it ran for a test file. With `LTR_TRACE_PER_WORKER` (Vitest's parallel workers) each worker appends to `<SESSION_TRACE_FILE>.<pid>-<threadId>`. `tn` is the space-joined full name (`ResultStore`'s). Paths are the runner's real paths; `session/traceRecords.ts` (`applyTraceRecords`, both frameworks) maps them back (`fromRunnerPath`) and builds the `ExecutionTraceStore` indexes.
- **Vitest trace on/off** — `VitestTrace` (extension) writes the wrapper per root and session, or keeps it off with a reason (`liveTestRunner.vitestTrace`, Vitest < 3, no Vite, the marker's `ok: false`, a traced batch with no result → rerun as configured, a result without an `F` record — type-check results, tagged `typecheck` by the reporter, are exempt). Vitest 3 workspaces (`vitest.workspace.*`, `test.workspace`) are loaded by the wrapper and passed inline as `test.workspace`, each entry wrapped like `test.projects`.
- **Source files beyond JS / TS** (`session/sourceFiles.ts`) — a save reruns tests for the list (`.vue`, `.svelte`, `.astro`, `.marko`, `.mdx`, `.coffee`, …), the Jest config's `moduleFileExtensions` (`IProjectConfig.sourceExtensions`) or any file the trace saw run; never for `NON_SOURCE_EXTENSIONS`. The coverage scan counts untested components from their `<script>` blocks (`scriptOf`). Vitest: the plugin has no list — it instruments any compiled module whose combined map leads back to the file (`mapsBackTo`), after its Vite plugin. Jest: the batch config routes them to the session transform only for extensions the project transforms; it runs the project's transformer (sync, or `processAsync` / `import()` for ESM-only ones) and instruments the output with every location moved back through the transformer's map (`remapLocations`; unmapped compiler code is not counted; a Vue render function marks the `<template>` lines as run — trace only). Both read maps with `shared/sourceMapLookup.js`.
- **Module graph (Vitest)** — the trace plugin writes Vite's module graph when Vitest closes its server (`LTR_VITEST_DEPS` → `traceRecords.applyDependencyFiles` → `ExecutionTraceStore.addImporters`); a save of a file no line of which ran (HTML, `?raw`, plugin-read templates) reruns `getDependentTestFiles`. Jest has no graph: a non-JS file nothing knows reruns the tests of same-folder sources that name it (`'./x.html'`, `SessionManager.referencingSources`). A Vitest root with type-check files also runs `vitest related <src> --typecheck.only` after a trace rerun.
- **Jest: our files are never transformed** — `transformIgnorePatterns` gets the extension's instrumentation folder (`ownFilesPattern`). Transformers that reject instrumented code (type-checking: ts-jest, jest-preset-angular, or seen failing) are compiled first; their map (returned or inline) moves locations back to the source.
- **Jest ESM mode** — the test script's and `.npmrc`'s Node options (runner `testScriptNodeOptions` / `npmrcNodeOptions` / `jestNodeEnv`; `jestEsmHint` for load errors) go into `NODE_OPTIONS` of every Jest the extension starts (`runtimeArgs` when debugging); with `supportsStaticESM` the transform loads the runtime with `import` instead of `require`. `FrameworkServices.traceOffReason(root)` exposes it to `SessionManager` (saves use `vitest related`) and the hover.
- **Coverage** (Jest) — instrumented code counts into `globalThis.__cov[<file hash>].s/b/f`; on exit each worker appends `{"workerPid":…, "cov":{…}}` to `COVERAGE_OUTPUT_FILE`; the transform writes a manifest per file (statement / branch / function locations) to `LTR_MANIFEST_DIR`, named by path + content hash.
- **Per-file results** — JSONL appended to `LTR_REPORTER_FILE`: `{"ltrEvent":"start","testFilePath","at"}` when a file begins, then the file's result (`testFilePath`, `status`, `testResults[]`, `console[]`, `startTime`/`endTime`) when it ends; the batch runner polls this file every 200 ms.
- **Logging** — `[LTR:<level>] message` lines on stderr, filtered by `LTR_LOG_LEVEL` (see developer guide → Logging).

### Editor decorations

**`DecorationManager`** owns all `TextEditorDecorationType` instances. Applied to visible editors after each run, after discovery, and when an editor becomes active.

Gutter icons are SVG files in `resources/icons/`:

| Icon | File | Meaning |
|------|------|---------|
| ✓ green | `passed.svg` | Test passed |
| ✗ red | `failed.svg` | Test failed |
| ⟳ amber | `running.svg` | Test running (SVG `animateTransform`) |
| ○ grey | `pending.svg` | Not yet run / discovered but not run |

Inline duration text appears after each test line, colour-coded by configurable thresholds.

Lifecycle:
- Extension activates → `CodeLensProvider` registered; `TestDiscoveryService` starts
- Discovery progresses → `DecorationManager.onDiscoveryProgress()` → `_refreshAll()` applies pending icons to visible editors; `CodeLensProvider.onDiscoveryProgress()` → `refresh()` surfaces `▶ Run` / `▷ Debug` lenses immediately
- Discovery completes → same refresh path
- File result arrives → `LineMap` rebuilt with Jest's authoritative `location.line`, decorations refreshed for that file
- Editor becomes active → decorations applied from existing `LineMap`
- Session stops → `decorationManager.clearAll()` resets all icons (decoration *types* are kept alive so pending icons from discovery survive)

**`CoverageDecorationManager`** (`src/editor/CoverageDecorationManager.ts`) — dedicated manager for coverage gutter decorations. Completely separate from `DecorationManager`; uses its own `TextEditorDecorationType` instances.

Three thin vertical bar states per executable line (3px wide rect, distinct from debug breakpoints which are filled circles):

| Decoration | Trigger | Visual |
|---|---|---|
| Covered | Line executed, all branches taken | Solid green bar |
| Partial | Line executed, ≥1 branch arm never taken | Amber bar |
| Uncovered | Line never executed | Dim red bar |
| Stale tint | `'measured-stale'` entry (file saved, rerun pending) | Subtle grey `backgroundColor` tint over entire file — bars remain visible underneath |
| Not yet run | `'counted'` entry | Nothing shown |

Line classification reads the coverage manifest (statement IDs + locations, branch IDs + arm counts) and counters (`s`, `b`, `f`) from `CoverageEntry`. A line is **partial** when it has ≥1 branch whose arm count array contains a zero; otherwise if hit count > 0 it is **covered**; if hit count = 0 it is **uncovered**. Functions without dedicated decoration — an uncovered function's declaration line shows as uncovered (red bar).

Subscribes to `CoverageStore.onDidChange` and redraws all visible editors on each change. Reads the coverage manifest from disk on demand (path stored in the `CoverageEntry`) to get per-line hit data. Clears on session stop.

**`CodeLensProvider`** scans files with a regex (no AST) to find `describe`, `it`, and `test` blocks:

```
/^\s*(describe|it|test)\s*[\.(]/
```

Three lenses per block:
- `▶ Run` — reruns this scope (`liveTestRunner.rerunFromEditor`)
- `▷ Debug` — launches Jest under debugger (`liveTestRunner.debugFromEditor`)
- `◈ Results` — focuses the results panel (`liveTestRunner.focusResult`) — only on `it`/`test` lines with a known result

`CodeLensProvider` is registered on extension **activate** (not on session start). It is always present — lenses appear as soon as discovery populates a `LineMap` entry for the file. Disposing the provider registration only happens on full extension deactivation.

### Views

Both views extend `BaseWebviewProvider`, which handles webview lifecycle, `postMessage` routing, and the `IResultObserver` base.

**`ExplorerView`** (sidebar) — always visible during a session. Shows the recursive file → node tree (unlimited nesting) with live status icons, duration badges, search, and per-row rerun buttons.

**`ResultsView`** (editor panel) — three resizable columns:

```
┌─────────────────┬──────────────────────────┬────────────────────────┐
│  Col 1: Tests   │  Col 2: Output           │  Col 3: Errors         │
│                 │  [All][Log][Info][Warn]   │                        │
│  File           │  [Error]                  │  ✗ test name           │
│    Suite        │                           │  <failure message>     │
│      ✓ test     │  📄 file.test.ts  just now│                        │
│      ✗ test     │  console.log output here  │  ✗ test name 2         │
│                 │                           │  <failure message>     │
│                 │  🔹 failing test  5s ago  │                        │
│                 │  console.log from test    │                        │
└─────────────────┴──────────────────────────┴────────────────────────┘
```

**Column 1** — same test list layout as the sidebar. Clicking a row scopes columns 2 and 3. Selection syncs between both views — selecting in either the sidebar or results panel highlights the same row in both.

**Column 2** — log output scoped to the selected row, filtered by level tab (All / Log / Info / Warn / Error). Each scope that has output shows a header with icon, label, and timestamp. Empty scopes show a placeholder.

**Column 3** — failure entries scoped to the selected row. Each entry shows the test name (red) and raw failure message in a monospace block.

**Scoping rules:**

| Selection | Output sections shown | Errors shown |
|-----------|----------------------|--------------|
| File row | File section always. Suite/test sections only if individually rerun. | All failures in the file |
| Suite row | Suite section always (placeholder if empty). Test sections only if individually rerun. | All failures in the suite |
| Test row | Test section always (placeholder if empty). | That test's failure, or "No failures" |

### Webview messaging

| Type | Direction | Purpose |
|------|-----------|---------|
| `full-file-result` | Extension → both | Complete file result tree; drives column 1 |
| `scope-changed` | Extension → both | Row selection changed; highlights new row |
| `scope-logs` | Extension → results only | Log + error data for the selected scope; drives columns 2 & 3 |
| `run-started` | Extension → both | Resets UI for a full run |
| `files-rerunning` | Extension → both | Marks specific files as running (partial rerun) |
| `init` | Extension → both | Sends configurable thresholds on session start |
| `select` | Webview → extension | User clicked a row |
| `rerun` | Webview → extension | User clicked a rerun button |
| `open-file` | Webview → extension | User wants to open a file in the editor |
| `ready` | Webview → extension | Webview signals it has initialised |
| `route` | Extension → both | Switch view: `{ type: 'route', view: 'timeline' \| 'results' \| ... }` |
| `timeline-loading` | Extension → ResultsView | Show spinner while instrumented run is in progress |
| `timeline-ready` | Extension → both | Instrumented run complete; carries serialised `TimelineStore` |
| `timeline-error` | Extension → ResultsView | Instrumented run failed |
| `timeline-exited` | ResultsView → extension | User navigated away from timeline mode |
| `step-changed` | ResultsView → extension | User stepped to a new step; carries `stepId`, `filePath`, `line` |
| `step-update` | Extension → ExplorerView | Forward of step-changed to sync sidebar panels |
| `timeline-rerun` | ExplorerView → extension | User clicked Re-run in the timeline sidebar |
| `projects` | Extension → ExplorerView | Project list + live state for the switcher row (also in `init`) |
| `select-project` | ExplorerView → extension | User picked a project in the switcher (`liveTestRunner.selectProject`) |

`scope-logs` and `scope-changed` are always sent as separate messages.

**Key design boundary:** playback state lives entirely in the `ResultsView` webview (`PlaybackEngine`). The extension host receives `step-changed` events and reacts (editor highlight, sidebar sync). The extension host never drives playback. Column 1 updates on every run. Columns 2 and 3 update on selection changes or when a run completes for the currently selected scope. Keeping them separate avoids unnecessary re-renders.

### Duration colour thresholds

Per-level, user-configurable via `liveTestRunner.durationThresholds.*`:

| Level | Green | Amber | Red |
|-------|-------|-------|-----|
| test | < 100 ms | 100–500 ms | > 500 ms |
| suite | < 500 ms | 500–2000 ms | > 2000 ms |
| file | < 1000 ms | 1000–5000 ms | > 5000 ms |

Threshold logic lives in `src/utils/duration.ts` (TypeScript) and is mirrored in `src/webview/utils.js` (plain JS globals for the webview sandbox). The extension reads current settings via `getThresholds()` and passes them to each webview in the `init` message.

---

## Full execution flow

```
Extension activates
  → extension.ts
      → CodeLensProvider registered (always active)
      → TestDiscoveryService.start()
          → vscode.workspace.findFiles → test file paths
          → Batches of 8 files, setImmediate yield between batches:
              → Read source → discoverTests() (AST) → store.fileDiscovered/suiteDiscovered/testDiscovered
              → LineMap built from AST line numbers
              → onFileDiscovered callback → IResultObserver.onDiscoveryProgress()
                  → ExplorerView.postMessage(discovery-progress) → test tree builds live
                  → ResultsView.postMessage(discovery-progress) → test list builds live
                  → DecorationManager._refreshAll()   → pending ○ icons appear
                  → CodeLensProvider.refresh()         → ▶ Run / ▷ Debug lenses appear
          → onComplete → IResultObserver.onDiscoveryComplete()
              → Start Testing re-enabled

User clicks "Start Testing"
  → extension.ts → SessionManager.start()
      → TestDiscoveryService.awaitDiscovery()  (no-op — already done)
      → file paths read from ResultStore
      → SessionManager._runFiles(all)          warm-up run
          → For each file (up to 3 in parallel):
              → JestRunner
                  → FrameworkDetector          detects: jest | cra | …
                  → FrameworkAdapter           resolves binary + config
                  → Executor                   spawns jest --json --outputFile=<tmp>
                  → ResultParser               parses JSON → RunResult
              → JestAdapter._applyFileResult() writes to ResultStore + LineMap (replaces AST line numbers with Jest's authoritative location.line)
              → IResultObserver.notify() → ExplorerView, ResultsView, DecorationManager
      → CoverageMap built from coverage data
      → On-save listener enabled

**Session Isolation** — every window uses a unique `session-<pid>-<ts>` directory. The extension host creates this on startup and injects it into all internal components (`SessionManager`, `JestAdapter`, `JestBatchRunner`). This ensures that multiple VS Code windows never conflict on shared temporary filenames.

User saves a file
  → SessionManager.onSave(filePath)            debounced 300ms
      → services.isConfigFile(filePath)?  (jest.config.* / vitest.config.* / vite.config.* / the script's --config)
          → Yes: restart the session — config, runnable files and every result re-read
      → isTestFile(filePath)?
          → Yes: run that file
          → No:  _runAffectedBySourceFile(filePath)
                   ExecutionTraceStore.getAffectedTestFiles(filePath)?
                     → Has trace data:
                         isSharedVars:true  → run whole test file
                         isSharedVars:false → run individual test cases
                                              (combined --testNamePattern, one Jest process per file)
                         (a file where every non-skipped test is affected runs whole, as a batch)
                     → No trace data, or the framework's trace is off for the root
                       (services.traceOffReason — Vitest: see VitestTrace):
                         batchRunner.runRelated?  (Vitest: `vitest related <src> --run` as a live batch —
                                                  files claimed on file-start, results streamed, coverage measured,
                                                  started-without-result files retried through _runFiles)
                         else adapter.runRelatedTests (plain `jest --findRelatedTests`) → whole files

User clicks "▶ Run" CodeLens
  → liveTestRunner.rerunFromEditor(filePath, lineNumber)
      → it/test line: LineMap lookup → rerun that test via --testNamePattern
      → describe line: regex extracts suite title → reruns suite via --testNamePattern
      → unresolved: runs whole file

User clicks "▷ Debug" CodeLens
  → liveTestRunner.debugFromEditor(filePath, lineNumber)
      → resolves scope same as rerun
      → vscode.debug.startDebugging({
            program: jest binary,
            args: [filePath, --runInBand, --no-coverage, --testNamePattern <name>],
        })

User clicks "◈ Results" CodeLens
  → liveTestRunner.focusResult(fileId, suiteId, testId)
      → reveals Test Results panel
      → selectionState.select() → scope-changed broadcast → row highlighted in both webviews

User stops session
  → decorationManager.clearAll()      gutter icons cleared; decoration types kept alive
  → child processes killed
  → on-save listener disabled
  (CodeLensProvider remains registered; LineMaps and pending icons are preserved)
```

---

## Key design decisions

| Decision | Reason |
|----------|--------|
| `--outputFile` preferred over stdout | Prevents Windows pipe-buffering from truncating large JSON. Stdout is still captured and used as a fallback — CRA occasionally writes JSON to stdout on a bailed run instead of to the output file. |
| CRA: extract config via `--showConfig`, run Jest directly | Full flag control — `--json`, `--outputFile`, `--no-bail` all work; `react-scripts` strips them |
| All binaries resolved from project `node_modules` | Never a global binary; projects with different Jest versions don't conflict |
| In-memory CRA config cache per session | `--showConfig` takes 2–3s; cached, invalidated if `package.json` changes |
| `FrameworkAdapter` interface in both packages | Adding a framework = one file in each package, nothing else |
| `TestRunner` interface for extension-runner boundary | Extension never imports concrete runner classes |
| `scope-logs` separate from `scope-changed` | Different lifecycles — avoids unnecessary re-renders in columns 2 and 3 |
| Output stored at run scope, never back-filled | Jest JSON only reports console at file level; correct attribution, no fabricated data |
| Custom webview, not VS Code Test Explorer API | Avoids a Mac-specific API bug; full cross-platform control |
| Regex line scan for CodeLens (no AST) | Simpler, no parse overhead; sufficient for line-level `describe`/`it`/`test` detection |
| Static AST discovery on activate, not on Start Testing | Full test tree (with line numbers, pending icons, and CodeLens) appears immediately on project open. Start Testing only needs to run tests — it skips discovery entirely by awaiting the already-resolved `awaitDiscovery()` promise. |
| Batch + `setImmediate` yield for discovery | Parsing 500+ files in one synchronous pass would block the extension host. Batches of 8 with a yield between each keep the UI responsive while the tree builds progressively. |
| Watcher re-discovers on any non-running status | Skipping only `'running'` files (not `pending`/`passed`/`failed`) means newly added tests appear in the tree on the next save, without waiting for a full re-run. |
| `fileStarted` preserves pre-discovered structure | When a file is already in the store (from discovery), `fileStarted` reuses the existing node tree and only marks entries `running`. The tree never disappears or resets mid-run. |
| `DecorationManager.clearAll()` instead of `dispose()` on session stop | Decoration types stay alive so pending icons from discovery survive session stop/start cycles. `dispose()` is reserved for full extension deactivation. |
| `LineMap` stores identity only | Status and duration always read from `ResultStore` — single source of truth, never stale |
| `extension.ts` ≤ 110 lines | Wires instances and registers commands only; no business logic |
| `CONCURRENCY = 3` for parallel runs | Balances throughput against system load; configurable constant |
| Session guard on all background behavior | No surprise background work; resource usage is predictable |
| One `ProjectContext` (stores, discovery, services, `SessionManager`) per project; views bound to the selected one | File ids stay naturally namespaced, background projects keep running untouched, single-project behaviour is unchanged (phase 7) |
| A root with its own test config is one project, never split per package | Its config already runs its packages (Jest `projects`, Vitest `test.projects`); splitting would run tests twice or with the wrong config |
| Projects are detected, never started automatically; `maxRunningProjects` caps active sessions | A monorepo with 30 packages must not spawn 30 test runners on open (D11) |
| `step-changed` boundary: playback in webview, editor in host | `PlaybackEngine` drives the timeline UI inside the webview sandbox. The extension host only reacts to `step-changed` — it never drives playback. This keeps the playback loop fast (no round-trips) and the editor highlight authoritative. |
| `TimelineDecorationManager` separate from `DecorationManager` | Timeline decorations (whole-line highlight, ghost text, hover) never touch pass/fail gutter icons. Two completely independent `TextEditorDecorationType` sets. |
| Webview router instead of new tabs | Both `ResultsView` and `ExplorerView` implement an internal JS router. Timeline mode is a view swap inside an existing panel — no new VS Code panel is registered. |
| `logPanel.js` / `errorPanel.js` as shared components | Same rendering code in both normal and timeline modes. Extracted from `resultsView.js` and consumed by `timelineView.js` without modification. |
