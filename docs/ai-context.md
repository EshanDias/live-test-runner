# AI Context — Live Test Runner

Paste this document into a conversation to give an AI assistant complete knowledge of the Live Test Runner codebase — what it is, how it works, where everything lives, and the rules that govern it.

---

## What this is

**Live Test Runner** is a VS Code extension that runs Jest tests automatically on file save and shows results directly in the editor. It is a Wallaby-lite tool — session-based, explicit start/stop, focused on speed.

**Current version:** 1.5.0  
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
├── TestRunner.ts                     Interface the extension uses (+ RunnerOptions)
├── CommandRunner.ts                  Generic CLI runner: binary/config/extra args, chunking, kill, coverage; abstract buildArgs(RunRequest)
├── JestRunner.ts                     extends CommandRunner — Jest flags only
├── VitestRunner.ts                   extends CommandRunner — `run|list|related` + files as leadingArgs; toVitestNamePattern (" " → "(?: > | )")
├── framework/
│   ├── FrameworkRegistry.ts          register(adapter, priority); default(): CRA 300 → Vitest 200 → Jest 100 (built lazily)
│   ├── FrameworkDetector.ts          First matching registry adapter; detectWithReason(); unknown → plain Jest + one WARN
│   └── adapters/
│       ├── FrameworkAdapter.ts       Interface: detect, resolveBinary, resolveConfig, getExtraArgs, outputFileArg, parseResult, capabilities, createRunner
│       ├── JestAdapter.ts            Plain Jest + Next.js + Jest
│       ├── CRAAdapter.ts             Create React App
│       └── VitestAdapter.ts          Vitest: detect (no Jest marker), vitest.mjs, config, version → capabilities, Node check; runner = VitestRunner
│   ├── UnsupportedFrameworkError.ts
│   ├── refusingAdapter.ts            stand-in adapter a runner keeps for another framework's project
│   ├── vitestConfig.ts               testScriptVitestArgs: config-relevant flags of the test script (follows nr/npm run/pnpm)
│   └── vitestProjects.ts             vitestProjects(): projects + browser flag via the project's own Vitest node API (browser-mode guard)
├── resolution/
│   ├── BinaryResolver.ts             Finds jest binary in project node_modules
│   └── RunnerPaths.ts                Symlinked roots: editor path ↔ the test runner's realpath
├── execution/
│   └── Executor.ts                   Spawns the runner, reads its result file (flag from adapter.outputFileArg) on exit
└── parsing/
    ├── ResultParser.ts               Parses Jest JSON output → RunResult (adapter.parseResult for Jest/CRA)
    ├── VitestResultParser.ts         parseVitestResult: Vitest 1–5 json reporter → RunResult (fixtures: test/fixtures/vitest)
    ├── runResults.ts                 emptyRunResult / mergeRunResults — any framework
    └── mergeFileResults.ts           Merges reports of one file run by several Jest projects
```

**Process model:** Jest is always `node <jest/bin/jest.js>` (`BinaryResolver.resolveJestEntry`, CRA: `resolveCraJestEntry`) with **no shell** — Windows `.cmd` shims broke arguments and paths with spaces. `nodeRuntime()` prefers `node` on PATH. `Executor.kill()` kills the process tree; `timeoutMs` stops a hanging run. Path arguments: forward slashes + upper-case drive (`toJestPathArg`).

**Batch run command (JestBatchRunner — initial run and on-save file reruns):**
```sh
node jest.js --watchAll=false --forceExit --no-bail --runTestsByPath <file1> [file2 …] \
     --config <ltr-temp-config.js> --cacheDirectory <per-project transform cache> \
     --maxWorkers=1 --testLocationInResults --verbose=false
```
The temp config starts from the project's config as Jest resolves it (`JestProjectConfig`: `jest --showConfig` / `react-scripts test --showConfig`, once per session, JSON in the session dir) plus:
- `sessionTraceTransform.js` at the front of the transform chain (light trace: line hit maps + coverage counters)
- `ltrCoverageSetup.js` as the **first** `setupFilesAfterEnv` entry — coverage flush, per-test trace context (`beginTest` / `endTest`), test-start/end heartbeats for the hang watchdog
- `liveReporter.js` as an extra reporter that appends a `start` record and one result record per file to a JSONL file

The parent process polls that JSONL file at 200 ms intervals via `Executor.runWithReporterPolling`, firing a callback per record so the UI updates while Jest is still running. Reported and traced paths are mapped back to store keys.

**Run lifecycle (SessionManager):** runs register in a registry — one `onRunProgress` total and one `onRunFinished` across overlapping runs; a session token makes Stop final. `jest --listTests` at session start decides which discovered files are runnable (others: skipped, `file.excluded`).

**Single-test / scoped-rerun command (JestRunner — CodeLens and individual reruns):**
```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults [--testNamePattern <name>]
```
`--outputFile` is mandatory here. Never parse Jest's stdout — on Windows, large JSON is silently truncated through pipes.

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

ConsoleEntry   // console output per file; Vitest adds scope ('file'|'suite'|'test') + scopeName
  message: string
  type: string   // 'log' | 'warn' | 'error' | 'info' | 'debug'
  origin: string
```

**Deprecated aliases** — `JestJsonResult`, `JestFileResult`, `JestTestCaseResult`, `JestConsoleEntry` remain exported for backward compatibility. Do not use in new code.

---

### `packages/vscode-extension` — `live-test-runner`

```
src/
├── extension.ts                    Entry point — wires views + ProjectRegistry, registers commands
├── project/                        Monorepos & multi-root workspaces (phase 7)
│   ├── ProjectRegistry.ts          Detects the projects (runner findTestProjects / projectRoot setting), owns one ProjectContext each, the selected one, status bar text, start limit
│   ├── ProjectContext.ts           Per project: ResultStore / ExecutionTraceStore / CoverageStore, TestDiscoveryService + DiscoveryCache, DetectingFrameworkProvider, SessionManager, session dir; ProjectObserverGate (forwards events only while selected)
│   └── projectLimits.ts            maxRunningProjects: auto (2, or 1 with ≤ 4 cores / < 4 GB free) and the refusal message (pure)
├── IResultObserver.ts              Interface: onSessionStart/Stop, onRunStart, onFileResult,
│                                   onDiscoveryStarted/Progress/Complete (optional)
├── store/
│   ├── ResultStore.ts              In-memory File→Node tree (recursive) + LineMap + ScopedOutput
│   ├── ExecutionTraceStore.ts      Trace indexes: traceIndex, coverageIndex, sourceToTests
│   └── SelectionState.ts           Tracks selected row; broadcasts scope-changed
├── coverage/
│   ├── types.ts                    Manifest, FileCov, LiveCov, CoveragePct, CoverageTotals, CoverageEntry
│   ├── CoverageStore.ts            In-memory store: 'counted' → 'measured' → 'measured-stale' lifecycle
│   ├── SourceCounter.ts            Background scan at session start; populates CoverageStore with 'counted' entries
│   └── CoverageReport.ts           Stateless metric calculation (statements/branches/functions/lines)
├── cache/
│   └── DiscoveryCache.ts           Persistent Babel parse cache (mtime-keyed, per-project, LRU rotation)
├── session/
│   ├── SessionManager.ts           Session lifecycle, batched run pool (CONCURRENCY=cpus/4), on-save, rerun
│   ├── IProjectConfig.ts           Interface: the project's resolved runner config (get / reset)
│   ├── JestProjectConfig.ts        IProjectConfig for Jest: `jest --showConfig` once per session
│   ├── IBatchRunner.ts             Interface: runFiles(BatchRunOptions) / kill / reset — SessionManager's only view of batch runs
│   ├── JestBatchRunner.ts          Runs combined test+trace+coverage batches; populates ResultStore + ExecutionTraceStore + CoverageStore
│   │   instrumentation/            (protocol: docs/architecture.md → Session instrumentation protocol)
│   │   ├── shared/
│   │   │   ├── sessionTraceRuntime.js  __strace global: accumulates hit-maps per test/hook; flushes T/H records to JSONL — framework-neutral
│   │   │   └── testDiscovery.js        Static AST test discovery (bundled; used by TestDiscoveryService)
│   │   └── jest/
│   │       ├── sessionTraceTransform.js  Jest transform: injects __strace.step() (trace) + __cov counters (coverage) + writes manifest
│   │       ├── ltrCoverageSetup.js       setupFilesAfterEnv: trace context per test, __cov flush on exit, heartbeats
│   │       └── liveReporter.js           Custom Jest reporter: appends one JSON record per completed file to a JSONL file
│   ├── VitestBatchRunner.ts        IBatchRunner for Vitest: one process per batch, results streamed per file (reporter events), per-test hang limit, Vitest coverage → CoverageStore
│   ├── VitestProjectConfig.ts      IProjectConfig for Vitest: the config file path
│   └── TestDiscoveryService.ts     Static AST discovery on activate + FileSystemWatcher (BATCH_SIZE_COLD=5, BATCH_SIZE_WARM=25)
├── framework/
│   ├── IFrameworkAdapter.ts        detect, discoverTests, isTestFile, runFile, runTestCase,
│   │                               getAffectedTests, getDebugConfig
│   ├── FrameworkServices.ts        FrameworkServices bundle + IFrameworkServicesProvider (servicesFor / all) + SingleFrameworkProvider + DetectingFrameworkProvider (Vitest or Jest per root)
│   ├── jestServices.ts             createJestServices(): the Jest bundle (adapter, JestProjectConfig, JestBatchRunner, JestInstrumentedRunner, session runner)
│   ├── vitestServices.ts           createVitestServices(): adapter, VitestProjectConfig, VitestBatchRunner, no instrumented runner
│   ├── RunnerBackedAdapter.ts      Shared IFrameworkAdapter half: file / test-case / related runs, FileRunResult → ResultStore
│   ├── JestAdapter.ts              Jest detection, JestRunner (jestCommand / runMode), debug config
│   └── VitestAdapter.ts            Vitest detection, VitestRunner (vitestCommand), debug config (autoAttachChildProcesses)
├── editor/
│   ├── CodeLensProvider.ts         ▶ Run / ▷ Debug / ◈ Results / ⏱ Timeline via regex line scan
│   ├── DecorationManager.ts        Gutter icons + inline duration text
│   ├── CoverageDecorationManager.ts  Coloured ▌ bar (before pseudo-element) per line: green=covered, amber=partial, red=uncovered, grey=neutral; stale overlay (grey background tint) when rerun is pending
│   └── CoverageHoverProvider.ts    HoverProvider for JS/TS files: shows which tests cover the hovered line (with status + duration + clickable links), and branch arm hit/miss detail for partially-covered lines. First 5 shown inline; "Show all N" link fires liveTestRunner.showCoveringTests → Quick Pick with fuzzy search over all covering tests
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
        ├── coverageExplorerView.js Coverage tab in Explorer sidebar: project totals + per-file breakdown; clicking a row opens the file in the editor
        └── timelineSidebar.js      Sidebar State / Watch / Call Stack panels for timeline mode
```

---

## Session lifecycle

**Projects (phase 7):** on activate `ProjectRegistry.refresh()` detects the test projects (one per workspace folder with its own test config; one per workspace package with tests under a monorepo root without one; the `liveTestRunner.projectRoot` setting pins one root) and builds a `ProjectContext` each — none is started (D11). The first (or remembered / active-editor) project is selected; the views show it, Start / Stop act on it, and only its discovery runs now (the others on first selection or Start). Everything below happens **per project**. Several projects may run at once, up to `liveTestRunner.maxRunningProjects`; a background project keeps running and rerunning on save, its events held back by its `ProjectObserverGate` until it is selected again.

**On extension activate (before any user action):**
1. `DiscoveryCache` loaded from `globalStorageUri/cache/<folderName>-<hash8>/discovery-cache.json` (if exists). A `session.lock` PID file is written.
2. `TestDiscoveryService.start()` → `vscode.workspace.findFiles` → list of test file paths
3. `onDiscoveryStarted(total)` fired → sidebar shows `⟳ Discovering… 0 / N`, Start Testing disabled
4. Files parsed in batches — **cold** (no cache): 5 files per batch; **warm** (cache present): 25 files per batch. Each file: `DiscoveryCache.get(filePath)` checks mtime → cache hit skips readFile + Babel entirely; cache miss reads source → `@babel/parser` AST walk → result stored via `DiscoveryCache.set()`. Store populated via `store.nodeDiscovered` → `onBatchDiscovered` → sidebar rows appended incrementally via `DocumentFragment` (no full re-render per batch).
5. `cache.flush()` writes dirty entries to disk after discovery completes.
6. `onDiscoveryComplete()` → Start Testing re-enabled
7. `FileSystemWatcher` activated — new/changed test files are re-discovered immediately (guard: skip files with `running` status); watcher also calls `cache.flush()` after re-discovery

**User clicks Start Testing:**
1. `SessionManager.start()` → `await discovery.awaitDiscovery()` (no-op if already done)
2. File list read from `store.getAllFiles()` — no second file scan needed
3. `onRunStarted` pushed to UI with the already-populated pending tree
4. `_runFiles` builds a batch queue: `BATCH_SIZE = clamp(ceil(N / CONCURRENCY), 5, 50)` files per batch; `CONCURRENCY = max(1, floor(cpuCount / 4))` parallel Jest processes
5. Each batch: files marked `running` in store → single Jest process via `JestBatchRunner.runFiles` with combined test+trace+coverage instrumentation; `liveReporter.js` streams per-file results as they complete; `onFileDone` notifies observers after each file
6. After Jest exits: `JestBatchRunner` parses (a) the light-trace JSONL → updates `ExecutionTraceStore`; (b) the coverage counters JSONL → promotes `CoverageStore` entries from `'counted'` to `'measured'` using manifests on disk
7. In parallel with step 5: `SourceCounter` AST-scans every source file and populates `CoverageStore` with `'counted'` (0-hit) entries so untouched files are included in coverage denominators
7. On-save listener enabled

**On save (debounced 300ms):**
```
if (isTestFile(savedFile))
  → run that file

else (source file saved)
  → _runAffectedBySourceFile(savedFile)
      1. Check ExecutionTraceStore.getAffectedTestFiles(savedFile)
         If trace data exists:
           For each affected test file:
             suites with isSharedVars:true  → run whole file
             suites with isSharedVars:false → run individual test cases
                                              (single Jest invocation with combined --testNamePattern)
         If no trace data yet (first run not complete):
           → fall back to CoverageMap / jest --findRelatedTests (whole files)
```

**Stop:** kill child processes, `clearAll()` on decorations (types kept alive), `resultStore.clearAllLineMaps()`, disable on-save.

---

## Data model

### `ResultStore`

Single source of truth for all test results. All views read from here.

Uses a **flat node pool** (`Map<string, TestNode>`) with tree relationships managed via `parentId` and `children` arrays. Supports unlimited nesting depth.

```
ResultStore
  ├── files: Map<filePath, FileResult>
  │     FileResult
  │       ├── filePath, name, status, duration
  │       ├── output: ScopedOutput
  │       └── rootNodeIds: string[]      ← top-level nodes in this file
  │
  └── nodes: Map<nodeId, TestNode>       ← flat pool, O(1) lookup
        TestNode
          ├── id, type ('suite' | 'test' | 'template')
          ├── name, fullName, status, duration
          ├── parentId: string | null
          ├── children: string[]            ← dynamic variations attached here
          ├── line?: number
          ├── output: ScopedOutput
          └── failureMessages: string[]
```

**Node IDs** follow a stable, path-based convention: `{filePath}::{suite1}::{suite2}::…::{name}`. Static discovery and Jest results automatically match without a lookup table.

**Status rollup:** `bubbleUpStatus(nodeId)` propagates worst-case status from a leaf node up through all ancestors in O(depth). Priority: `running > failed > passed > skipped > pending`. Empty `template` nodes are ignored during rollup.

**Incremental summary:** A running counter tracks test counts so `getSummary()` is O(1), not O(n).

### `ExecutionTraceStore`

Derived indexes built from per-test JSONL trace files written by `JestBatchRunner` after each instrumented run. These are read-only caches — the trace files on disk are the source of truth. All three indexes are rebuilt from traces and cleared together on session reset.

```
ExecutionTraceStore
  ├── traceIndex: Map<testId, string>
       testId (full test name, e.g. "Suite > test name") → absolute path to .jsonl trace file
      One file per test case written to session-specific trace directory.
  │
  ├── coverageIndex: Map<filePath, Set<lineNumber>>
  │     Every source file line executed by any test in the session.
  │     Accumulates across all runs — never decrements mid-session.
  │     Used for session-wide gutter coverage decorations.
  │
  └── sourceToTests: Map<sourceFilePath, SourceTestMapping>
        SourceTestMapping: {
          [testFilePath: string]: {
            [suiteName: string]: {
              isSharedVars: boolean    // true → must run whole suite on rerun
              sharedVarNames: string[] // variable names that are shared (for display)
              testCases: string[]      // full test names in this suite
            }
          }
        }
        Populated by JestBatchRunner after each file run.
        Used by SessionManager._runAffectedBySourceFile() to scope on-save reruns
        to the specific test cases that actually executed code from the changed file.
```

**Relationship between the stores:**
- `ResultStore` answers "what happened" — pass/fail, output, failure messages
- `ExecutionTraceStore` answers "what ran and where" — which source lines executed, which tests cover which files
- `CoverageStore` answers "how much is covered" — statement/branch/function/line percentages; includes untouched files via `SourceCounter`
- No store writes to another; `SessionManager` and `JestBatchRunner` coordinate all three

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
- Suite/node rerun → that node's `output` set
- Test rerun → `TestNode.output` set
- **Never back-fill** node output from file-level output
- Vitest attributes output (`ConsoleEntry.scope`): every test that ran gets its own lines (possibly none), suites their hooks' lines — attribution, not back-fill

### `LineMap`

```typescript
LineMap: Map<filePath, Map<lineNumber, LineEntry>>
LineEntry: { nodeId: string, fileId: string }
```

Identity only — **never status or duration**. `DecorationManager` always queries `ResultStore.getNode(nodeId)` for those values.

**Lifecycle:**
- Discovery → `clearLineMap(filePath)` then populate from AST line numbers — pending icons appear immediately
- File result arrives → `clearLineMap(filePath)` then repopulate from Jest `location.line` — replaces AST lines with authoritative run-time lines
- Session stop → `clearAllLineMaps()`
- `clearAllLineMaps()` is **not** called at run start — discovery-sourced lines stay valid until each file's own result arrives

---

## Webview messaging

| Type | Direction | Purpose |
|------|-----------|---------|
| `batch-file-results` | Extension → both views | Batched file results (up to 50 ms window); preferred over `full-file-result` for runs |
| `full-file-result` | Extension → both views | Single file result (legacy; still handled); complete file result tree |
| `scope-changed` | Extension → both views | Row selection; highlights row in column 1; also sent in `init` as `selection` field for restore on visibility |
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
| `projects` | Extension → ExplorerView | Switcher row: `ProjectSummary[]` (name, framework, state idle/discovering/running/watching, counts, progress, selected) — also in `init`; shown with 2+ projects |
| `select-project` | ExplorerView → extension | User picked a project → `liveTestRunner.selectProject` |

`init` also carries `running` (`{completed,total,failed}` or null) so a project switched to mid-run shows its progress. File objects carry `group` (Vitest project name, D12) when the config has several `test.projects`.

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
- `liveTestRunner.selectProjectRoot` — pins the window to one root (writes `liveTestRunner.projectRoot`; "Detect all projects" clears it)
- `liveTestRunner.selectProject` — "Select Project": switch the project the views show (quick pick, or an id / name argument; the Explorer switcher row uses it)
- `liveTestRunner.stopAllProjects` — "Stop All Projects"
- `liveTestRunner.startTesting` / `stopTesting` accept an optional project id (root) argument; without it they act on the selected project
- `liveTestRunner.showOutput` — "Show Test Output": raw Jest / Vitest output channel
- `liveTestRunner.showLogs` — "Show Logs": levelled extension log channel
- `liveTestRunner.openGuide` — "Open Guide": the user guide shipped in `out/guide/guide.html` (copied from `docs/live-test-runner-guide.html`) in a webview tab (`views/GuidePanel.ts`); the same page is on GitHub Pages (`.github/workflows/pages.yml`)
- `liveTestRunner.copyDiagnostics` — "Copy Diagnostic Report": versions, project setup, settings, recent logs → clipboard + untitled doc
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
| `liveTestRunner.projectRoot` | `""` | Pin the window to one project root; empty = detect every test project |
| `liveTestRunner.maxRunningProjects` | `"auto"` | Projects running at once: `auto` = 2, or 1 with ≤ 4 CPU cores or < 4 GB free memory; or a number ≥ 1 |
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
| Vitest | In progress (3.0.0) — runner package done for runs (`VitestAdapter` + `VitestRunner`); Vitest-specific parsing and extension wiring follow (plan tasks 2.3–2.8) |

---

## Key files by purpose

| Purpose | File |
|---------|------|
| Wire everything | `packages/vscode-extension/src/extension.ts` |
| Projects of the workspace (detection rules) | `packages/runner/src/framework/projectDiscovery.ts` |
| Per-project state, selected project, gate | `packages/vscode-extension/src/project/ProjectRegistry.ts`, `ProjectContext.ts` |
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
| Execution trace indexes | `packages/vscode-extension/src/store/ExecutionTraceStore.ts` |
| Per-file trace runner | `packages/vscode-extension/src/session/JestBatchRunner.ts` |
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
| Jest spawn (line-buffered, UTF-8 safe, `[LTR:level]` routing) | `packages/runner/src/execution/Executor.ts` |
| Extension logger (LogOutputChannel, ring buffer) | `packages/vscode-extension/src/utils/logger.ts` |
| Runner/core logger + sink | `packages/runner/src/utils/logger.ts` |
| Diagnostic report | `packages/vscode-extension/src/utils/diagnostics.ts` |
| User guide tab | `packages/vscode-extension/src/views/GuidePanel.ts` |
| Vitest coverage → CoverageStore | `packages/vscode-extension/src/coverage/istanbulCoverage.ts` |
| Vitest batches | `packages/vscode-extension/src/session/VitestBatchRunner.ts` |
| Vitest-specific logic | `packages/vscode-extension/src/framework/VitestAdapter.ts`, `packages/runner/src/VitestRunner.ts` |
| Known bugs + root causes | `docs/bugs-and-issues.md` |
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
8. **Multi-Session Isolation is mandatory.** Never use global shared temporary directories for runner configs or traces. Always use the window-local `LTR_SESSION_TMP_DIR` injected via constructors — per project, the `ProjectContext.sessionDir` (a sub-folder when the window has several projects).
18. **Per-project state lives in `ProjectContext`.** Never add a window-wide store or framework bundle: a new store goes into `ProjectContext` and views bind to the selected project (`bindProject` / `bind`). Views never pull from a project that is not selected; background projects reach them only through their gate.
9. **Safe Cleanup.** On activation, the extension host must only delete stale session folders belonging to dead processes (verified via `process.kill(pid, 0)`). Never perform recursive blind deletions in the base temp root.
10. **Persistent Templates.** AST-discovered dynamic test headers (`.each`) are `template` nodes. They must survive cleanup and status rollups even when childless.
11. **Nested Branch Compatibility.** The recursive tree must support arbitrary depth. High-level status rollups must be reliable even when only deep-nested leaves are rerun. Always bubble status changes up the full ancestor chain.
12. **`IInstrumentedRunner` is the only abstraction for instrumented runs.** `extension.ts` holds a reference typed as `IInstrumentedRunner` — never as the concrete `JestInstrumentedRunner`. Adding Vitest or Mocha timeline support = one new file implementing this interface.
13. **`TimelineDecorationManager` is separate from `DecorationManager`.** It never touches pass/fail gutter icons — completely independent decoration types.
14. **Timeline Maps are serialised before postMessage.** `TimelineStore.variables` and `TimelineStore.logs` are `Map<number, ...>` in the extension host. They are converted to plain objects (`Object.fromEntries`) before sending to webviews, since Maps are not JSON-serialisable.
15. **`scope-logs` and `scope-changed` are always separate messages.** They have different lifecycles.
16. **Logging goes through the logger, never `console.*` or the Test Output channel.** Extension: `logger.scope('Area')`. runner/core: `createLogger('Area')`. Instrumentation inside Jest: `[LTR:<level>] msg` on stderr. One `info` summary per run; per-file detail at `debug`/`trace`. See developer-guide → Logging.
17. **Session Jest runs pass `--verbose=false`.** Jest auto-enables verbose for single-file runs, which stops console buffering and empties `testResult.console` (Results panel shows no logs).
