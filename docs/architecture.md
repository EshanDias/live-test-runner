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
| Primary sidebar | **Explorer view** — file → suite → test tree, summary counts, search |
| Panel › Output | **Raw output channel** — every Jest command + full stderr, unformatted ANSI |
| Panel › Test Results | **Results view** — 3-column scoped view |
| Editor gutter | Status icons (✓ / ✗ / ⟳ / ○) per test line |
| Editor inline | Duration text after each test, colour-coded |
| Editor CodeLens | `▶ Run`, `▷ Debug`, `◈ Results` above each block |
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
}
```

Registered observers: `ExplorerView`, `ResultsView`, `DecorationManager`.

### Data store

**`ResultStore`** — the single source of truth for all result data.

```
ResultStore
  └── Map<filePath, FileResult>
        └── FileResult
              ├── status, duration
              ├── output: ScopedOutput     ← console lines captured at file level
              └── suites: Map<suiteId, SuiteResult>
                    └── SuiteResult
                          ├── name, status, duration
                          ├── output: ScopedOutput   ← populated only on suite-level reruns
                          └── tests: Map<testId, TestResult>
                                └── TestResult
                                      ├── name, fullName, status, duration
                                      ├── location?: { line, column }
                                      ├── output: ScopedOutput  ← populated only on test-level reruns
                                      └── failureMessages: string[]
```

**`LineMap`** — inside `ResultStore`:

```
LineMap: Map<filePath, Map<lineNumber, LineEntry>>
LineEntry: { testId, suiteId, fileId }   // identity only — never status or duration
```

`LineMap` stores identity only. `DecorationManager` always queries `ResultStore` for status and duration at decoration time — they are never duplicated into the map, so they are never stale.

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

**Output scoping rules:** Jest JSON reports console output at file level only. When a file runs, only `FileResult.output` is set. Suite and test output are set only when that scope is individually rerun via `--testNamePattern`. Output is never back-filled or fabricated for scopes that haven't been run individually.

**`SelectionState`** — tracks which row the user has selected in the results panel. Emits `scope-changed` messages when selection changes.

### Session management (`SessionManager`)

1. **Start Testing** — calls `discoverTests()`, runs warm-up (all files, up to 3 in parallel), enables on-save listener
2. **On save** — debounced (default 300ms); classifies file as test or source; runs accordingly
3. **Stop Testing** — kills child processes, clears decorations, disables on-save

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

**`DecorationManager`** owns all `TextEditorDecorationType` instances. Applied to visible editors after each run and when an editor becomes active.

Gutter icons are SVG files in `resources/icons/`:

| Icon | File | Meaning |
|------|------|---------|
| ✓ green | `passed.svg` | Test passed |
| ✗ red | `failed.svg` | Test failed |
| ⟳ amber | `running.svg` | Test running (SVG `animateTransform`) |
| ○ grey | `pending.svg` | Not yet run |

Inline duration text appears after each test line, colour-coded by configurable thresholds.

Lifecycle:
- Session starts → `registerCodeLensProvider` called, decorations applied to all visible editors
- File result arrives → `LineMap` rebuilt, decorations refreshed for that file
- Editor becomes active → decorations applied from existing `LineMap`
- Session stops → `decorationManager.dispose()` clears and destroys all decoration types

**`CodeLensProvider`** scans files with a regex (no AST) to find `describe`, `it`, and `test` blocks:

```
/^\s*(describe|it|test)\s*[\.(]/
```

Three lenses per block:
- `▶ Run` — reruns this scope (`liveTestRunner.rerunFromEditor`)
- `▷ Debug` — launches Jest under debugger (`liveTestRunner.debugFromEditor`)
- `◈ Results` — focuses the results panel (`liveTestRunner.focusResult`) — only on `it`/`test` lines with a known result

CodeLens is session-guarded: the provider is only registered while a session is active. Disposing the registration removes all lenses immediately.

### Views

Both views extend `BaseWebviewProvider`, which handles webview lifecycle, `postMessage` routing, and the `IResultObserver` base.

**`ExplorerView`** (sidebar) — always visible during a session. Shows the file → suite → test tree with live status icons, duration badges, search, and per-row rerun buttons.

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

`scope-logs` and `scope-changed` are always sent as separate messages. Column 1 updates on every run. Columns 2 and 3 update on selection changes or when a run completes for the currently selected scope. Keeping them separate avoids unnecessary re-renders.

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
User clicks "Start Testing"
  → extension.ts → SessionManager.start()
      → JestAdapter.discoverTests()            jest --listTests → file paths
      → SessionManager._runFiles(all)          warm-up run
          → For each file (up to 3 in parallel):
              → JestRunner
                  → FrameworkDetector          detects: jest | cra | …
                  → FrameworkAdapter           resolves binary + config
                  → Executor                   spawns jest --json --outputFile=<tmp>
                  → ResultParser               parses JSON → RunResult
              → JestAdapter._applyFileResult() writes to ResultStore + LineMap
              → IResultObserver.notify() → ExplorerView, ResultsView, DecorationManager
      → CoverageMap built from coverage data
      → On-save listener enabled

User saves a file
  → SessionManager.onSave(filePath)            debounced 300ms
      → isTestFile(filePath)?
          → Yes: run that file
          → No:  CoverageMap lookup → fallback jest --findRelatedTests
                 run affected files

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
  → decorationManager.dispose()       gutter icons cleared, decoration types destroyed
  → codeLensDisposable.dispose()      CodeLens removed from all editors
  → resultStore.clearAllLineMaps()    LineMap wiped
  → child processes killed
  → on-save listener disabled
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
| Regex line scan for CodeLens (no AST) | Simpler, no parse overhead; sufficient for `describe`/`it`/`test` detection |
| `LineMap` stores identity only | Status and duration always read from `ResultStore` — single source of truth, never stale |
| `extension.ts` ≤ 110 lines | Wires instances and registers commands only; no business logic |
| `CONCURRENCY = 3` for parallel runs | Balances throughput against system load; configurable constant |
| Session guard on all background behavior | No surprise background work; resource usage is predictable |
