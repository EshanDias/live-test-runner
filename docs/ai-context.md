# AI Context — Live Test Runner

Paste this document into a conversation to give an AI assistant complete knowledge of the Live Test Runner codebase — what it is, how it works, where everything lives, and the rules that govern it.

---

## What this is

**Live Test Runner** is a VS Code extension that runs Jest tests automatically on file save and shows results directly in the editor. It is a Wallaby-lite tool — session-based, explicit start/stop, focused on speed.

**Current version:** 2.2.0  
**Language:** TypeScript  
**Package manager:** pnpm (monorepo)

---

## Three packages

### `packages/core` — `@live-test-runner/core`

```
src/
├── TestSession.ts      Session lifecycle: start / stop / reset
├── CoverageMap.ts      Map<SourcePath, Set<TestPath>> — built from Jest coverage output
└── SelectionPolicy.ts  Legacy; minimal use
```

`CoverageMap` is the primary mechanism for determining which tests to re-run when a source (non-test) file is saved. Built once during the warm-up run, updated incrementally on each on-save run. Fallback: `jest --findRelatedTests`.

---

### `packages/runner` — `@live-test-runner/runner`

Framework-agnostic execution engine. VS Code layer depends only on the `TestRunner` interface.

```
src/
├── types.ts                          Framework enum, Status enum, result types
├── TestRunner.ts                     Interface the extension uses
├── JestRunner.ts                     Thin orchestrator — wires the layers
├── framework/
│   ├── FrameworkDetector.ts          Reads package.json → picks adapter from ADAPTER_PRIORITY
│   └── adapters/
│       ├── FrameworkAdapter.ts       Interface: detect, resolveBinary, resolveConfig, getExtraArgs
│       ├── JestAdapter.ts            Plain Jest + Next.js + Jest
│       ├── CRAAdapter.ts             Create React App
│       └── ViteAdapter.ts            Vitest stub — not yet implemented
├── resolution/
│   └── BinaryResolver.ts             Finds jest binary in project node_modules
├── execution/
│   └── Executor.ts                   Spawns Jest, reads --outputFile JSON on exit
└── parsing/
    └── ResultParser.ts               Parses runner JSON output → RunResult
```

**Every run uses this command:**
```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults [--testNamePattern <name>]
```

**`--outputFile` is mandatory.** Never parse Jest's stdout — on Windows, large JSON is silently truncated through pipes.

**CRA:** `CRAAdapter.resolveConfig()` runs `react-scripts test --showConfig --passWithNoTests` once per session, extracts the hidden Jest config JSON, writes it to a temp file, then all runs invoke Jest directly. `react-scripts` is never used at run time. Config is cached in memory; invalidated if `package.json` changes.

**Result types** (framework-agnostic — all runners produce these shapes):
```typescript
RunResult
  FileRunResult
    TestCaseRunResult
      status: 'passed' | 'failed' | 'pending' | 'todo' | 'skipped'
      duration?: number
      location?: { line: number, column: number }
      failureMessages: string[]
      ancestorTitles: string[]

ConsoleEntry   // console output per file
  message: string
  type: string   // 'log' | 'warn' | 'error' | 'info' | 'debug'
  origin: string
```

**Deprecated aliases** — `JestJsonResult`, `JestFileResult`, `JestTestCaseResult`, `JestConsoleEntry` remain exported for backward compatibility. Do not use in new code.

---

### `packages/vscode-extension` — `live-test-runner`

```
src/
├── extension.ts                    Entry point — wires, registers commands, kicks off discovery
├── IResultObserver.ts              Interface: onSessionStart/Stop, onRunStart, onFileResult,
│                                   onDiscoveryStarted/Progress/Complete (optional)
├── store/
│   ├── ResultStore.ts              In-memory File→Suite→Test tree + LineMap + ScopedOutput
│   └── SelectionState.ts           Tracks selected row; broadcasts scope-changed
├── session/
│   ├── SessionManager.ts           Session lifecycle, run pool (CONCURRENCY=3), on-save, rerun
│   └── TestDiscoveryService.ts     Static AST discovery on activate + FileSystemWatcher
├── framework/
│   ├── IFrameworkAdapter.ts        detect, discoverTests, isTestFile, runFile, runTestCase,
│   │                               getAffectedTests, getDebugConfig
│   └── JestAdapter.ts              All Jest-specific logic
├── editor/
│   ├── CodeLensProvider.ts         ▶ Run / ▷ Debug / ◈ Results / ⏱ Timeline via regex line scan
│   └── DecorationManager.ts        Gutter icons + inline duration text
├── utils/
│   └── duration.ts                 durationLabel, durationColorVar, getThresholds
├── views/
│   ├── BaseWebviewProvider.ts      Webview lifecycle + postMessage routing + IResultObserver base
│   ├── ExplorerView.ts             Sidebar: file/suite/test tree
│   └── ResultsView.ts              Panel: 3-column detail view (or timeline view)
├── timeline/                       Timeline Debugger — step-by-step test replay
│   ├── IInstrumentedRunner.ts      Framework-agnostic interface for instrumented runs
│   ├── JestInstrumentedRunner.ts   Jest implementation: spawns Jest with traceTransform, parses JSONL
│   ├── TimelineStore.ts            Interfaces: TimelineStore, Step, VariableSnapshot, LogEntry, ErrorEntry
│   ├── TimelineEvent.ts            Union type for STEP / VAR / LOG / ERROR / ASSERT events
│   ├── TimelineDecorationManager.ts  Active-line highlight + inline ghost text + hover provider
│   ├── instrumentation/
│   │   ├── traceTransform.js       Jest transform (CJS): injects __trace.step/var calls via AST
│   │   ├── traceRuntime.js         __trace global: writes events as JSONL to TRACE_OUTPUT_FILE
│   │   └── testDiscovery.js        AST walker: extracts describe/it/test names + line numbers
│   └── __fixtures__/
│       └── sample-events.jsonl     Hand-written fixture for parseEvents smoke tests
└── webview/                        Browser-side assets (not compiled by tsc)
    ├── explorer.html
    ├── results.html
    ├── router.js                   Single-page router: mount/unmount views on { type: 'route' }
    ├── testListLayout.js           Shared test list renderer used by both views
    ├── utils.js                    JS mirror of duration.ts; exposes window.LiveTestUtils
    ├── styles.css
    ├── timeline/
    │   └── PlaybackEngine.js       Webview playback: currentStepId, next/prev/jumpTo/play/pause
    ├── components/
    │   ├── logPanel.js             Shared log output component (mount/update/unmount)
    │   └── errorPanel.js           Shared error output component (mount/update/unmount)
    └── views/
        ├── resultsView.js          Normal results view (uses logPanel + errorPanel)
        ├── timelineView.js         Timeline bar + controls + console/errors right panel
        ├── testListView.js         Sidebar test list view
        └── timelineSidebar.js      Sidebar State / Watch / Call Stack panels for timeline mode
```

---

## Session lifecycle

**On extension activate (before any user action):**
1. `TestDiscoveryService.start()` → `vscode.workspace.findFiles` → list of test file paths
2. `onDiscoveryStarted(total)` fired → sidebar shows `⟳ Discovering… 0 / N`, Start Testing disabled
3. Files parsed in batches of 8 (event-loop yield between batches) — each file: read source → `@babel/parser` AST walk → extract suites + tests with 1-based line numbers → `store.fileDiscovered / suiteDiscovered / testDiscovered` → `onDiscoveryProgress(file, n, total)` → sidebar list and gutter icons update incrementally
4. `onDiscoveryComplete()` → Start Testing re-enabled
5. `FileSystemWatcher` activated — new/changed test files are re-discovered immediately (guard: skip files with `running` status)

**User clicks Start Testing:**
1. `SessionManager.start()` → `await discovery.awaitDiscovery()` (no-op if already done)
2. File list read from `store.getAllFiles()` — no second file scan needed
3. `onRunStarted` pushed to UI with the already-populated pending tree
4. Warm-up run on all files (up to 3 in parallel)
5. Each file: detect framework → resolve binary → resolve config → spawn Jest → parse JSON → `JestAdapter._applyFileResult()` writes `ResultStore` + `LineMap` → notify all observers
6. `CoverageMap` built from coverage data
7. On-save listener enabled

**On save (debounced 300ms):**
```
if (isTestFile(savedFile))  → run that file
else
  affected = CoverageMap.get(savedFile) ?? jest --findRelatedTests savedFile
  run affected files
```

**Stop:** kill child processes, `clearAll()` on decorations (types kept alive), `resultStore.clearAllLineMaps()`, disable on-save.

---

## Data model

### `ResultStore`

Single source of truth. All views read from here.

```
ResultStore
  Map<filePath, FileResult>
    FileResult
      ├── status, duration
      ├── output: ScopedOutput
      └── suites: Map<suiteId, SuiteResult>
            SuiteResult
              ├── name, status, duration
              ├── output: ScopedOutput
              └── tests: Map<testId, TestResult>
                    TestResult
                      ├── name, fullName, status, duration
                      ├── location?: { line, column }
                      ├── output: ScopedOutput
                      └── failureMessages: string[]
```

### `ScopedOutput`

```typescript
interface ScopedOutput {
  lines: OutputLine[]
  capturedAt: number | null   // null = never run at this scope
}
interface OutputLine {
  text: string
  level: 'log' | 'info' | 'warn' | 'error'
  timestamp: number
}
```

**Output attribution:**
- Full file run → `FileResult.output` set only
- Suite rerun → `SuiteResult.output` set
- Test rerun → `TestResult.output` set
- **Never back-fill** suite/test output from file-level output

### `LineMap`

```typescript
LineMap: Map<filePath, Map<lineNumber, LineEntry>>
LineEntry: { testId: string, suiteId: string, fileId: string }
```

Identity only — **never status or duration**. `DecorationManager` always queries `ResultStore` for those values.

**Lifecycle:**
- Discovery → `clearLineMap(filePath)` then populate from AST line numbers — pending icons appear immediately
- File result arrives → `clearLineMap(filePath)` then repopulate from Jest `location.line` — replaces AST lines with authoritative run-time lines
- Session stop → `clearAllLineMaps()`
- `clearAllLineMaps()` is **not** called at run start — discovery-sourced lines stay valid until each file's own result arrives

---

## Webview messaging

| Type | Direction | Purpose |
|------|-----------|---------|
| `full-file-result` | Extension → both views | Complete file result tree; drives column 1 |
| `scope-changed` | Extension → both views | Row selection; highlights row in column 1 |
| `scope-logs` | Extension → results only | Log + error data for selected scope; drives columns 2 & 3 |
| `run-started` | Extension → both | Resets UI for full run |
| `files-rerunning` | Extension → both | Marks files as running (partial rerun) |
| `init` | Extension → both | Sends `thresholds` on session start |
| `select` | Webview → extension | User clicked a row |
| `rerun` | Webview → extension | User clicked rerun button |
| `open-file` | Webview → extension | User wants to open a file |
| `ready` | Webview → extension | Webview initialised |
| `route` | Extension → both | Switch view: `{ type: 'route', view: 'timeline' \| 'results' \| 'testList' \| 'timelineSidebar' }` |
| `timeline-loading` | Extension → ResultsView | Show spinner while instrumented Jest run is in progress |
| `timeline-ready` | Extension → both | Instrumented run complete; carries serialised `TimelineStore` |
| `timeline-error` | Extension → ResultsView | Instrumented run failed; carries error message |
| `timeline-exited` | ResultsView → extension | Timeline view unmounted (user navigated away) |
| `step-changed` | ResultsView → extension | User stepped to a new step; carries `stepId`, `filePath`, `line` |
| `step-update` | Extension → ExplorerView | Forward of step-changed; sidebar syncs State/Watch/Call Stack |
| `add-to-watch` | Extension → ExplorerView | Add a variable to the sidebar Watch panel |
| `timeline-rerun` | ExplorerView → extension | User clicked Re-run in the timeline sidebar |

**Rule:** `scope-logs` and `scope-changed` are always sent as separate messages. Different lifecycles; keeping them separate prevents double-renders.

### `scope-logs` payload shape

```typescript
{
  type: 'scope-logs',
  payload: {
    logSections: Array<{
      label: string
      scope: 'file' | 'suite' | 'test'
      capturedAt: number | null
      lines: Array<{ text: string, level: string, timestamp: number }>
    }>
    errorSections: Array<{
      label: string
      scope: 'file' | 'suite' | 'test'
      errors: Array<{ testName: string, failureMessages: string[], capturedAt: number | null }>
    }>
  }
}
```

---

## Editor decorations

### Gutter icons

SVG files in `resources/icons/`. One `TextEditorDecorationType` per state:

| File | Colour | Meaning |
|------|--------|---------|
| `passed.svg` | Green | Test passed |
| `failed.svg` | Red | Test failed |
| `running.svg` | Amber | Currently running |
| `pending.svg` | Grey | Not yet run |

`DecorationManager` applies decorations to visible editors after each file result and when an editor becomes active (`onDidChangeActiveTextEditor`). All types cleared and disposed on session stop.

### Inline duration

Rendered via `renderOptions.after` on the same `DecorationOptions` as the gutter icon. Colour-coded by thresholds (see below).

### CodeLens

Regex scan — no AST:
```
/^\s*(describe|it|test)\s*[\.(]/
```

Three lenses per matching line:
- `▶ Run` — always shown on `describe`, `it`, `test`
- `▷ Debug` — always shown on `describe`, `it`, `test`
- `◈ Results` — only on `it`/`test` lines that have a `LineMap` entry

**Session guard:** `CodeLensProvider` registered only while session is active. Disposing the registration removes all lenses.

### Command behavior

| Command | Scope resolution |
|---------|----------------|
| `liveTestRunner.rerunFromEditor` | `it`/`test` line → LineMap lookup → `--testNamePattern`. `describe` line → regex extracts title → `--testNamePattern`. Unresolved → run whole file. |
| `liveTestRunner.debugFromEditor` | Same resolution. Launches `vscode.debug.startDebugging` with `--runInBand --no-coverage`. |
| `liveTestRunner.focusResult` | Reveals Results panel, calls `selectionState.select()`. |

---

## Test Results panel — 3 columns

```
┌─────────────────┬──────────────────────────┬────────────────────────┐
│  Col 1: Tests   │  Col 2: Output           │  Col 3: Errors         │
│                 │  [All][Log][Info][Warn]   │                        │
│  File           │  [Error]                  │  ✗ test name           │
│    Suite        │                           │  <failure message>     │
│      ✓ test     │  📄 file.test.ts  just now│                        │
│      ✗ test     │  console.log output here  │  ✗ test name 2         │
│                 │                           │  <failure message>     │
└─────────────────┴──────────────────────────┴────────────────────────┘
```

**Column 1** — test tree; drives selection; syncs with sidebar.

**Column 2** — log output scoped to the selected row. Each scope with output gets a header (icon + label + timestamp). The `[All][Log][Info][Warn][Error]` tabs filter all sections simultaneously. Empty scopes show a placeholder. Auto-scrolls; locks if user scrolls up.

**Column 3** — failure entries scoped to the selected row. Each entry: test name (red) + raw failure message in monospace.

**Scoping rules:**

| Selection | Output sections | Errors |
|-----------|----------------|--------|
| File | File section always. Suite/test sections only if individually rerun. | All failures in file |
| Suite | Suite section always (placeholder if empty). Test sections only if individually rerun. | All failures in suite |
| Test | Test section always (placeholder if empty). | That test's failure or "No failures ✓" |

---

## Duration colour thresholds

Per-level, user-configurable via `liveTestRunner.durationThresholds.*`:

| Level | Green | Amber | Red |
|-------|-------|-------|-----|
| test | < 100 ms | 100–500 ms | > 500 ms |
| suite | < 500 ms | 500–2000 ms | > 2000 ms |
| file | < 1000 ms | 1000–5000 ms | > 5000 ms |

Logic: `src/utils/duration.ts` (TypeScript) + `src/webview/utils.js` (plain JS mirror). Extension reads via `getThresholds()` and sends in `init` message. Webviews call `LiveTestUtils.setThresholds(msg.thresholds)`.

---

## VS Code contribution points

All in `packages/vscode-extension/package.json`:

**Commands:**
- `liveTestRunner.startTesting`
- `liveTestRunner.stopTesting`
- `liveTestRunner.selectProjectRoot`
- `liveTestRunner.showRawOutput`
- `liveTestRunner.rerunFromEditor`
- `liveTestRunner.debugFromEditor`
- `liveTestRunner.focusResult`
- `liveTestRunner.openTimelineDebugger` — opens the Timeline Debugger for a specific test
- `liveTestRunner.addToWatch` — adds a variable to the sidebar Watch panel (used by hover command links)
- `liveTestRunner.copyValue` — copies an inline variable value to the clipboard (used by hover command links)

**Views:**
- `liveTestRunner.explorerView` — sidebar, Activity Bar (beaker icon)
- `liveTestRunner.resultsView` — editor panel (Test Results tab)

**Status bar item:** bottom left; updates throughout session.

**Configuration:** `liveTestRunner.*` — see `contributes.configuration.properties` in `package.json`.

---

## Configuration settings

| Setting | Default | Description |
|---------|---------|-------------|
| `liveTestRunner.projectRoot` | `""` | Override auto-detected root |
| `liveTestRunner.runMode` | `"auto"` | `"auto"`: extension calls Jest directly (full structured output). `"npm"`: delegates to `npm test --` from your package.json scripts (limited structured output — see below). |
| `liveTestRunner.jestCommand` | `""` | Override Jest binary/command. Only used when `runMode` is `"auto"`. |
| `liveTestRunner.onSaveDebounceMs` | `300` | Debounce delay (ms) |
| `liveTestRunner.durationThresholds.testAmberMs` | `100` | Test amber threshold |
| `liveTestRunner.durationThresholds.testRedMs` | `500` | Test red threshold |
| `liveTestRunner.durationThresholds.suiteAmberMs` | `500` | Suite amber threshold |
| `liveTestRunner.durationThresholds.suiteRedMs` | `2000` | Suite red threshold |
| `liveTestRunner.durationThresholds.fileAmberMs` | `1000` | File amber threshold |
| `liveTestRunner.durationThresholds.fileRedMs` | `5000` | File red threshold |

---

## Framework support

| Framework | Status |
|-----------|--------|
| Jest | Fully supported |
| Create React App | Fully supported (via `--showConfig` + direct Jest invocation) |
| Vitest | Planned — `ViteAdapter` stub in `packages/runner` |

---

## Key files by purpose

| Purpose | File |
|---------|------|
| Wire everything | `packages/vscode-extension/src/extension.ts` |
| Timeline contracts | `packages/vscode-extension/src/timeline/IInstrumentedRunner.ts` |
| Timeline data model | `packages/vscode-extension/src/timeline/TimelineStore.ts` |
| Timeline event union | `packages/vscode-extension/src/timeline/TimelineEvent.ts` |
| Jest trace runner | `packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts` |
| Active-line highlight | `packages/vscode-extension/src/timeline/TimelineDecorationManager.ts` |
| Jest transform (CJS) | `packages/vscode-extension/src/timeline/instrumentation/traceTransform.js` |
| Trace runtime | `packages/vscode-extension/src/timeline/instrumentation/traceRuntime.js` |
| Webview playback | `packages/vscode-extension/src/webview/timeline/PlaybackEngine.js` |
| Webview router | `packages/vscode-extension/src/webview/router.js` |
| Shared log renderer | `packages/vscode-extension/src/webview/components/logPanel.js` |
| Shared error renderer | `packages/vscode-extension/src/webview/components/errorPanel.js` |
| Run lifecycle | `packages/vscode-extension/src/session/SessionManager.ts` |
| All result data | `packages/vscode-extension/src/store/ResultStore.ts` |
| Selection tracking | `packages/vscode-extension/src/store/SelectionState.ts` |
| Jest-specific logic | `packages/vscode-extension/src/framework/JestAdapter.ts` |
| Gutter + inline | `packages/vscode-extension/src/editor/DecorationManager.ts` |
| Run/Debug/Results buttons | `packages/vscode-extension/src/editor/CodeLensProvider.ts` |
| Duration utils (TS) | `packages/vscode-extension/src/utils/duration.ts` |
| Sidebar UI | `packages/vscode-extension/src/views/ExplorerView.ts` |
| Results panel UI | `packages/vscode-extension/src/views/ResultsView.ts` |
| Webview base | `packages/vscode-extension/src/views/BaseWebviewProvider.ts` |
| Shared list renderer | `packages/vscode-extension/src/webview/testListLayout.js` |
| Duration utils (JS) | `packages/vscode-extension/src/webview/utils.js` |
| Jest spawn | `packages/runner/src/execution/Executor.ts` |
| Framework detection | `packages/runner/src/framework/FrameworkDetector.ts` |
| CRA config extraction | `packages/runner/src/framework/adapters/CRAAdapter.ts` |
| Coverage mapping | `packages/core/src/CoverageMap.ts` |
| All user settings | `packages/vscode-extension/package.json` → `contributes.configuration` |

---

## Rules that must not be broken

1. **Prefer `--outputFile` over stdout, but stdout is the fallback.** `Executor` always appends `--outputFile=<tmpfile>` and reads that file on exit. Stdout is still captured in parallel — if the output file is missing or empty (CRA occasionally writes JSON to stdout on a bailed run instead), stdout is used. Do not remove the stdout capture.
2. **Never use `react-scripts` at run time.** Extract config via `--showConfig` once, then run Jest directly.
3. **Never run binaries globally.** Always resolve from the project's own `node_modules`.
4. **Never duplicate status/duration into `LineMap`.** `LineMap` stores identity only. Query `ResultStore` at decoration time.
5. **Never back-fill suite/test output from file-level output.** Empty output is correct for scopes that haven't been individually run.
6. **Never add business logic to `extension.ts`.** It wires instances and registers commands only.
7. **`SessionManager`, `ResultStore`, views, and observers must be framework-agnostic.** All framework differences live in `IFrameworkAdapter` implementations.
8. **`scope-logs` and `scope-changed` are always separate messages.** They have different lifecycles.
9. **`IInstrumentedRunner` is the only abstraction for instrumented runs.** `extension.ts` holds a reference typed as `IInstrumentedRunner` — never as the concrete `JestInstrumentedRunner`. Adding Vitest or Mocha timeline support = one new file implementing this interface.
10. **`TimelineDecorationManager` is separate from `DecorationManager`.** It never touches pass/fail gutter icons — completely independent decoration types.
11. **Timeline Maps are serialised before postMessage.** `TimelineStore.variables` and `TimelineStore.logs` are `Map<number, ...>` in the extension host. They are converted to plain objects (`Object.fromEntries`) before sending to webviews, since Maps are not JSON-serialisable.
