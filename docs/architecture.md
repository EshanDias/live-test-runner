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
| Panel › Output | **Raw output channel** — every Jest command + full stderr, unformatted ANSI |
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

**Coverage map:** built once during the warm-up run (full suite with coverage), updated incrementally on each on-save run. When a source file is saved, this map is checked first before falling back to `jest --findRelatedTests`.

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

Each adapter implements `FrameworkAdapter`:

| Method | Purpose |
|--------|---------|
| `detect(projectRoot)` | Returns true if this adapter handles the project |
| `resolveBinary(projectRoot)` | Returns absolute path to the test runner binary |
| `resolveConfig(projectRoot)` | Returns path to a resolved config file, or undefined |
| `getExtraArgs(projectRoot)` | Any extra CLI flags the framework needs |

Current adapters:

| Adapter | Handles | Notes |
|---------|---------|-------|
| `JestAdapter` | Jest, Next.js + Jest | Reads `jest.config.*` or `package.json#jest` directly |
| `CRAAdapter` | Create React App | Runs `--showConfig` once per session to extract the hidden config; cached in memory |
| `ViteAdapter` | Vitest | Stub — not yet implemented |

`FrameworkDetector` tries adapters in `ADAPTER_PRIORITY` order and returns the first match.

### Jest invocation

Every run uses the same deterministic command:

```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults [--testNamePattern <name>]
```

- `--outputFile=<tmpfile>` — primary JSON output path; avoids Windows pipe-buffering truncation for large payloads
- Stdout is **still captured** in parallel as a fallback — CRA occasionally skips `--outputFile` on a bailed run and writes JSON to stdout instead. `Executor` reads the tmpfile first; if it is missing or empty, it falls back to the captured stdout.
- `--no-bail` — collects all failures in a single pass
- `--testLocationInResults` — populates `location.line` used by gutter icons

### CRA-specific behavior

CRA hides its Jest configuration. You cannot pass `--json`, `--outputFile`, or `--no-bail` to `react-scripts test` directly.

`CRAAdapter` solves this:
1. Runs `react-scripts test --showConfig --passWithNoTests` once per session
2. Extracts the embedded Jest config JSON from the output
3. Writes it to a temp file
4. All subsequent runs invoke Jest directly — never `react-scripts` at run time

The extracted config is cached in memory per session and invalidated if `package.json` changes.

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

Approximately 110 lines. Creates instances, registers VS Code commands and event handlers, hands control to `SessionManager`. Contains no business logic.

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

Registered observers: `ExplorerView`, `ResultsView`, `DecorationManager`, `CodeLensProvider`.

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
              ├── id, type ('suite' | 'test')
              ├── name, fullName, status, duration
              ├── parentId: string | null
              ├── children: string[]
              ├── line?: number
              ├── output: ScopedOutput     ← populated only on scoped reruns
              └── failureMessages: string[]
```

Node IDs follow a stable path convention: `{filePath}::{suite1}::…::{name}`. Status rolls up via `bubbleUpStatus()` in O(depth). Summary counter is incremental (O(1)).

**`ExecutionTraceStore`** — derived indexes built from per-test JSONL trace files. The trace files on disk are the source of truth; these are fast-lookup caches rebuilt after each instrumented run.

```
ExecutionTraceStore
  ├── traceIndex: Map<testId, string>
  │     testId = full test name ("Suite > test") → absolute .jsonl path
  │     Written to /tmp/ltr-traces/<sessionId>/<safeTestName>.jsonl
  │     Used by: Timeline Debugger, future coverage overlay
  │
  ├── coverageIndex: Map<filePath, Set<lineNumber>>
  │     Every source line executed by any test in the session.
  │     Accumulates across runs — never resets mid-session.
  │     Used by: session-wide gutter coverage decorations (planned)
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
        Populated by SessionTraceRunner after each file run.
        Used by SessionManager._runAffectedBySourceFile() for smart on-save reruns.
```

**Relationship between the stores:**
- `ResultStore` answers "what happened" — pass/fail, output, failures
- `ExecutionTraceStore` answers "what ran and where" — which lines executed, which tests cover which source files
- The trace files are the ground truth; `ExecutionTraceStore` is derived. Clear both together on session reset.

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

**`SelectionState`** — tracks which row the user has selected in the results panel. Emits `scope-changed` messages when selection changes.

### Static test discovery (`TestDiscoveryService`)

Runs on extension activate — before the user clicks Start Testing.

1. **`start(projectRoot, store, log, callbacks)`** — finds all test files via `vscode.workspace.findFiles`, then parses them in batches of 8 with a `setImmediate` yield between batches. This keeps the extension host responsive on large projects (500+ files, 3000+ tests).
2. **Per-file** — reads source, runs `discoverTests()` (AST walker in `testDiscovery.js`), recursively walks the returned suite tree calling `store.nodeStarted` / `store.nodeResult` to build the hierarchical node tree. Rebuilds the `LineMap` for that file, and emits a serialised file object via `onFileDiscovered` callback.
3. **`awaitDiscovery()`** — returns the internal `Promise`; `SessionManager.start()` awaits this so it never re-discovers files that are already populated.
4. **`FileSystemWatcher`** — monitors `**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}`. New files appear immediately on create. On change/save the watcher skips files with status `'running'` (a run is already in progress for that file); for all other statuses it calls `store.removeFile()` and re-populates so newly added or renamed tests appear straight away without waiting for a run.

**`testDiscovery.js`** (pure AST walker, no code injection):
- Uses the project's own `@babel/parser` + `@babel/traverse` (lazy-loaded from the project root at first use)
- Handles: `describe` / `it` / `test`, `.only` / `.skip`, `.each([...])(name, fn)` (curried call pattern), `.concurrent.*`, deep `MemberExpression` chains
- Template literals: interleaves quasi text with `…` placeholders so interpolated names still appear in the tree (`"accepts valid severity …"`)
- Returns `{ suites, rootTests }` with accurate `line` numbers for every node

### Session management (`SessionManager`)

1. **Start Testing** — awaits `TestDiscoveryService.awaitDiscovery()` (no-op if discovery already finished), reads file paths directly from `ResultStore`, runs them all (up to 3 in parallel), enables on-save listener
2. **On save** — debounced (default 300ms); classifies file as test or source; for source files uses `_runAffectedBySourceFile` (trace-store driven with CoverageMap fallback)
3. **Stop Testing** — kills child processes, clears decorations, disables on-save

After each file run, `SessionTraceRunner` fires in the background (fire-and-forget): it re-runs the same file with the session trace transform, partitions the raw JSONL into per-test trace files, and updates all three `ExecutionTraceStore` indexes (`traceIndex`, `coverageIndex`, `sourceToTests`). Per-test console output from the trace run is applied back to `ResultStore` so the Results panel can show test-scoped logs.

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

Adding a new framework = one file implementing `IFrameworkAdapter`. `SessionManager`, `ResultStore`, all views, and all observers require zero changes.

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

User saves a file
  → SessionManager.onSave(filePath)            debounced 300ms
      → isTestFile(filePath)?
          → Yes: run that file
          → No:  _runAffectedBySourceFile(filePath)
                   ExecutionTraceStore.getAffectedTestFiles(filePath)?
                     → Has trace data:
                         isSharedVars:true  → run whole test file
                         isSharedVars:false → run individual test cases
                                              (combined --testNamePattern, one Jest process per file)
                     → No trace data:
                         CoverageMap lookup → fallback jest --findRelatedTests → run whole files

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
| `step-changed` boundary: playback in webview, editor in host | `PlaybackEngine` drives the timeline UI inside the webview sandbox. The extension host only reacts to `step-changed` — it never drives playback. This keeps the playback loop fast (no round-trips) and the editor highlight authoritative. |
| `TimelineDecorationManager` separate from `DecorationManager` | Timeline decorations (whole-line highlight, ghost text, hover) never touch pass/fail gutter icons. Two completely independent `TextEditorDecorationType` sets. |
| Webview router instead of new tabs | Both `ResultsView` and `ExplorerView` implement an internal JS router. Timeline mode is a view swap inside an existing panel — no new VS Code panel is registered. |
| `logPanel.js` / `errorPanel.js` as shared components | Same rendering code in both normal and timeline modes. Extracted from `resultsView.js` and consumed by `timelineView.js` without modification. |
