# Test Timeline Debugger — Living Specification (v4)

> **This is the authoritative living spec.**
> All decisions from prior discussions are resolved here.
> Future changes must update this document — not create a new one.

---

## 1. What This Is

The Test Timeline Debugger is a new feature within the Live Test Runner VS Code extension. It gives developers a step-by-step replay of a single test case — showing which lines executed, what variables held at each step, what was logged, and where things went wrong.

It is a Wallaby-style time-travel debugger, not a test runner replacement. It runs alongside the existing session system without interfering with it.

---

## 2. MVP Scope

- Framework: **Jest only** (Vitest, Mocha are future)
- Test type: **Unit tests** (frontend UI support is future)
- Platform: **VS Code Extension**
- Granularity: **One test case at a time**
- Variable tracking: **Instrumented at runtime via injected tracing calls**

---

## 3. How It Integrates with the Existing Extension

The Timeline Debugger is fully additive. The table below shows exactly what changes and what does not.

| Component | Change |
|---|---|
| `ResultStore` | **No change** |
| `ResultsView` | **Router added** — routes between `results.html` (normal) and `timeline.html` (debugger) |
| `ExplorerView` | **Router added** — routes between test list view and timeline sidebar view |
| `SessionManager` | **No change** |
| `JestRunner` / `JestAdapter` (runner pkg) | **No change** |
| `Executor.ts` | **Reused as-is** |
| `CodeLensProvider` | Add `⏱ Timeline` lens on `it`/`test` lines |
| `extension.ts` | Register new command; tell `ResultsView` and `ExplorerView` to route on activation |
| `package.json` | New command only — no new panel or view contributions |
| **New: `TimelineStore`** | Created fresh per debugger session |
| **New: `IInstrumentedRunner`** | Interface — framework-agnostic contract |
| **New: `JestInstrumentedRunner`** | Jest implementation of `IInstrumentedRunner`; reuses `Executor.ts` |
| **New: `PlaybackEngine`** | Webview-side JS class — owns current step, drives all playback |

### 3.1 One panel, one sidebar — routing not new tabs

The extension uses exactly one VS Code panel tab ("Test Results") and one sidebar view (the Explorer). No new tabs or views are ever registered for the timeline debugger.

Both `ResultsView` and `ExplorerView` implement an internal JS router. When the debugger activates, they route to the timeline view. When it closes, they route back. This is the same pattern as a single-page app — one shell, multiple views, swapped in and out of a `<div id="app">`.

```
ResultsView webview                  ExplorerView webview
─────────────────────                ─────────────────────
results.html (shell)                 explorer.html (shell)
  router.js                            router.js
  views/                               views/
    resultsView.js   ← normal            testListView.js   ← normal
    timelineView.js  ← debugger          timelineSidebar.js ← debugger
  components/                          components/
    logPanel.js      ← shared            (none shared yet)
    errorPanel.js    ← shared
```

The router listens for messages from the extension host and mounts/unmounts the appropriate view into `<div id="app">`:

```js
// router.js (same pattern in both webviews)
const views = { results: resultsView, timeline: timelineView }

window.addEventListener('message', ({ data }) => {
  if (data.type === 'route') {
    Router.go(data.view, data.payload)
  }
})

const Router = {
  current: null,
  go(viewName, payload) {
    if (this.current?.unmount) this.current.unmount()
    const app = document.getElementById('app')
    app.innerHTML = ''
    this.current = views[viewName]
    this.current.mount(app, payload)
  }
}
```

Each view file (`resultsView.js`, `timelineView.js`, etc.) exports `{ mount(container, payload), unmount() }`. No framework — plain JS and DOM.

### 3.2 Shared components

`logPanel.js` and `errorPanel.js` are standalone JS modules that both `resultsView.js` and `timelineView.js` import. They accept a container element and a data payload and render themselves. They have no knowledge of which view is using them.

```js
// logPanel.js
export function mount(container, { lines, filter }) { ... }
export function update(container, { lines }) { ... }
export function unmount(container) { ... }
```

This is the only place where code is shared between normal mode and timeline mode. Everything else is view-specific.

### 3.3 Activation

A new VS Code command is registered: `liveTestRunner.openTimelineDebugger`.

Triggered from two entry points:
- **`⏱ Timeline` CodeLens** — on `it`/`test` lines alongside `▶ Run` and `▷ Debug`
- **`⏱ Timeline` button** on each test row in `ExplorerView`

Both pass `{ filePath, testFullName }` to the command. No active session is required.

On activation:
1. Extension host sends `{ type: 'route', view: 'timeline', payload: { testFullName, filePath } }` to `ResultsView`
2. Extension host sends `{ type: 'route', view: 'timelineSidebar', payload: {} }` to `ExplorerView`
3. `JestInstrumentedRunner.run()` is called
4. On completion, `TimelineStore` is sent to both webviews

On close (user navigates away, session ends, or new debugger run starts):
1. Extension host sends `{ type: 'route', view: 'results', payload: { ... current results } }` to `ResultsView`
2. Extension host sends `{ type: 'route', view: 'testList', payload: {} }` to `ExplorerView`

### 3.4 Re-run from inside the debugger

A **Re-run** button sits in the timeline sidebar header (above State/Watch/Call Stack). Clicking it:
1. Clears the current `TimelineStore`
2. Shows a loading state in the timeline view
3. Calls `JestInstrumentedRunner.run()` again with the same `{ filePath, testFullName }`
4. On completion, sends the new `TimelineStore` to both webviews

The user stays in timeline mode throughout. No routing change on re-run.

### 3.5 TimelineStore

`TimelineStore` is a new in-memory store, separate from `ResultStore`. It holds timeline data for one test run and is replaced on each new debugger run. It lives in the extension host and is serialised and sent to the webview in full once the run completes.

```ts
interface TimelineStore {
  testId: string
  testFullName: string
  filePath: string
  steps: Step[]
  variables: Map<number, VariableSnapshot[]>  // keyed by stepId
  logs: Map<number, LogEntry[]>               // keyed by stepId
  errors: ErrorEntry[]
}

interface Step {
  stepId: number
  line: number
  file: string
  functionName?: string
  pageName?: string   // logical grouping for zoom levels
}

interface VariableSnapshot {
  name: string
  type: 'primitive' | 'object' | 'array'
  value?: any         // set for primitives
  keys?: string[]     // top-level keys for objects/arrays; children filled lazily
}

interface LogEntry {
  text: string
  level: 'log' | 'info' | 'warn' | 'error'
  timestamp: number
}

interface ErrorEntry {
  stepId: number
  testName: string
  failureMessages: string[]
}
```

### 3.6 IInstrumentedRunner — framework-agnostic interface

All instrumented runners implement this interface. This is the boundary that makes adding Vitest or Mocha later a single new file, with nothing else changing.

```ts
interface IInstrumentedRunner {
  run(options: {
    filePath: string
    testFullName: string
    projectRoot: string
  }): Promise<TimelineStore>

  cancel(): void
}
```

`JestInstrumentedRunner` is the only implementation in MVP. Future frameworks get their own implementation file. `extension.ts` holds a reference to `IInstrumentedRunner` — never to the concrete class.

### 3.7 JestInstrumentedRunner

Implements `IInstrumentedRunner`. Does not modify `JestRunner` or any existing adapter.

1. Takes `{ filePath, testFullName, projectRoot }`
2. Injects `__trace` instrumentation into the target test file at transform time (via a custom Jest `transform` config — the file on disk is never modified)
3. Spawns Jest via the existing `Executor.ts` with `--testNamePattern` scoped to the single test
4. Reads `__trace` events from a temp file written during the Jest run
5. Parses events into a `TimelineStore` and returns it

Instrumentation calls injected at transform time:

```js
__trace.step(stepId, line, file, functionName)
__trace.var(stepId, name, value)
__trace.assert(stepId, expected, actual, pass)
__trace.log(stepId, level, ...args)
```

Rules:
- `__trace` emits events only — no internal storage
- Events are written to a temp file path passed in via an environment variable
- The test file on disk is never modified

---

## 4. UI Layout

The Timeline Debugger reuses the existing "Test Results" panel and Explorer sidebar. Both switch view via their internal router. No new VS Code tabs or panels are opened.

```
┌──────────────────────────────────────────────────────────────────┐
│  Test Results panel — timeline mode                              │
├─────────────────┬────────────────────────────────────────────────┤
│  SIDEBAR        │  EDITOR SECTION (top, 60%)                     │
│  [Re-run]       │  [Code editor — active line highlighted]        │
│  ─────────      ├──────────────────────────────────┬─────────────┤
│  STATE          │  TIMELINE (75% of bottom strip)  │ LOGS (25%)  │
│  loading false  │  file · function · line 11       │ Console│Err │
│  incidents ▶    │  [1][2]..[■11][12]..[✗15]..     │             │
│  ─────────      │     ⏮  ◀  ▶  ▶|  ⏭  ⏸          │ log lines   │
│  WATCH          └──────────────────────────────────┴─────────────┤
│  total  42      (bottom strip, 40%)                              │
│  + add          │                                                 │
│  ─────────      │                                                 │
│  CALL STACK     │                                                 │
│  fetch :14      │                                                 │
│  reducer :42    │                                                 │
└─────────────────┴─────────────────────────────────────────────────┘
```

### 4.1 Default sizes

| Region | Default | Minimum |
|---|---|---|
| Editor section | 60% of panel height | 150px |
| Bottom strip (timeline + logs) | 40% of panel height | 100px |
| Timeline within bottom strip | 75% of strip width | — |
| Console/Errors within bottom strip | 25% of strip width | — |
| Sidebar | Fixed width ~180px | — |

All dividers between editor/strip and timeline/logs are draggable, no snapping, smooth resize.

When a UI Preview is present (future): it takes ~30% of the editor section top; code takes the rest. When absent: code fills the editor section fully.

### 4.2 Sidebar sections

**Re-run button** — sits at the top of the sidebar. Triggers a new instrumented run for the same test. Shows a spinner while running.

**State** — variables captured automatically at the current step by instrumentation. Updates on every step change. Objects and arrays show top-level keys with a `▶` expand control; children load lazily on expand.

**Watch** — user-controlled. Add variables via `+ add variable` text input or via `[Add to Watch]` in the editor hover. Entries persist for the debugger session. Each entry shows the variable's value at the current step.

**Call stack** — function chain at the current step. Each entry shows function name and line number. Clicking an entry moves the editor to that line.

---

## 5. Timeline Bar

### 5.1 Structure

- Full-width horizontal scrollable bar across the 75% timeline area
- Each box = one step (line / function / file depending on zoom)
- Pointer/cursor always sits at the current step; timeline scrolls to keep it visible
- Above the boxes: context label — `filename · functionName · line N` — updates on every step change including during drag

### 5.2 Zoom levels

| Zoom | Box represents | Label |
|---|---|---|
| Fully zoomed out | Files / pages | File name |
| Medium | Functions | Function name |
| Fully zoomed in | Lines | Line number |

Zoom controlled by mouse wheel or trackpad pinch. Max ~3 boxes visible at full zoom out. Labels truncate; hover tooltip shows full text.

### 5.3 Box states

| State | Visual |
|---|---|
| Default | Muted neutral |
| Active / current step | Accent blue — always distinct |
| Hovered | Subtle border highlight |
| Error step | Red tint |

### 5.4 Drag behaviour

- **Slow drag** — live updates at ~50–100ms throttle: context label updates, editor highlights line, sidebar State updates, console panel updates
- **Fast drag** — context label updates only; editor and sidebar do not update until release
- **Release** — full commit: editor jumps to line (switches file if needed), all panels update

### 5.5 Click

Clicking any box jumps directly to that step. Same behaviour as release after drag.

### 5.6 Loop handling

If a loop executes more than ~10 iterations, its steps are compressed into one box labelled `×N`. The box has a distinct visual treatment (e.g. striped). Expanding compressed loops is a future feature.

---

## 6. Playback Controls

Centred below the timeline boxes.

| Control | Action |
|---|---|
| `⏮` | Jump to first step |
| `◀` | Step backward one step |
| `▶` | Play forward (auto-steps at readable speed) |
| `▶\|` | Step forward one step |
| `⏭` | Jump to last step |
| `⏸` | Pause auto-play |

Auto-play advances one step at a time at a fixed interval (~200ms). Does not skip steps. Pauses automatically at the last step or at an error step.

---

## 7. PlaybackEngine

`PlaybackEngine` is a vanilla JS class that lives in the webview (`timelineView.js`). It is instantiated once when `timelineView` mounts and receives the full serialised `TimelineStore` upfront.

It owns:
- `currentStepId` — the single source of playback truth in the webview
- Auto-play interval timer
- All step navigation logic (next, prev, jump, play, pause)

On every step change it:
1. Updates the timeline bar (moves the pointer, scrolls if needed)
2. Updates the context label above the boxes
3. Updates the sidebar State and Watch panels
4. Updates the console panel (cumulative logs up to current step)
5. Sends a single message to the extension host: `{ type: 'step-changed', stepId, filePath, line }`

The extension host receives `step-changed` and does one thing: highlights that line in the active editor. No other extension-host logic is triggered by playback.

This boundary is intentional — all playback speed, scrubbing, and rendering happen in the webview. The extension host only handles the editor highlight, which requires VS Code API access.

---

## 8. Console and Error Panels

Located in the 25% right column of the bottom strip. Two tabs, one visible at a time. Default: Console.

### Console tab

Uses the shared `logPanel.js` component (same component as column 2 in normal `ResultsView`). Data passed in: all log entries from `TimelineStore` up to and including the current step. Updates on every step change via `PlaybackEngine`. Shows `step N ·` prefix before each log entry so the user knows when each log occurred.

Auto-scrolls to the latest entry for the current step unless the user has scrolled up manually.

### Errors tab

Uses the shared `errorPanel.js` component (same component as column 3 in normal `ResultsView`). Data passed in: all `ErrorEntry` records from `TimelineStore`. Static — does not change per step. Always shows the full failure output (test name in red, failure message in monospace) so the user keeps the error in view while navigating the timeline.

The Errors tab is always populated from the completed run. It is not step-aware by design.

---

## 9. Editor Integration

### Active line highlight

The extension host highlights the active line in the VS Code editor on every `step-changed` message. Uses a distinct decoration type (separate from the existing pass/fail gutter icons) — a blue left-border highlight on the current line, similar to a debugger breakpoint.

If the step is in a different file than the currently open editor, the extension host opens that file and highlights the line.

### Inline values

Variable values appear as inline ghost text after the relevant line, using VS Code's `renderOptions.after` decoration:

```ts
const price = 6          // 6
const qty = 7            // 7
const total = price * qty // 42
expect(total).toBe(42)   // ❌ expected 42, got 0
```

Only the value at the current step is shown. Previous values are visible on hover.

### Hover

Hovering an inline value shows a small popup:
- Current value
- Value history across steps (if the variable changed)
- `[Copy]` button
- `[Add to Watch]` button — adds to the Watch panel in the sidebar

---

## 10. Variable Tracking and Object Expansion

### Capture strategy

Primitives: stored by value. Objects and arrays: stored shallowly — top-level keys/count only. No deep serialisation at capture time.

```ts
// Primitive
{ name: 'total', type: 'primitive', value: 42 }

// Object
{ name: 'payload', type: 'object', keys: ['id', 'name', 'status'] }

// Array
{ name: 'incidents', type: 'array', keys: ['0', '1', '2'], count: 3 }
```

No external libraries. Custom serialiser handles circular references by tracking visited references and replacing with `[Circular]`.

### Lazy expansion

When the user expands an object/array node in State or Watch:
- Children are generated on demand from the stored shallow snapshot
- Each child follows the same shallow structure (expand again to go deeper)
- Expansion state is local to the UI — nothing re-runs

### Large arrays

Arrays with more than 100 items: show first 10 with a "Show more" control. The rendered list is virtualised — only visible nodes exist in the DOM at any time.

### Async values

Variables resolved after `await` are captured at the step where the resolved value first becomes available. The Watch panel shows `pending` for those variables until that step is reached.

---

## 11. Event System

Events emitted by instrumentation during the Jest run. Written to a temp file; read by `JestInstrumentedRunner` after the run completes.

```ts
type TimelineEvent =
  | { type: 'STEP'; stepId: number; line: number; file: string; functionName?: string }
  | { type: 'VAR';  stepId: number; name: string; snapshot: VariableSnapshot }
  | { type: 'ASSERT'; stepId: number; expected: any; actual: any; pass: boolean }
  | { type: 'ERROR'; stepId: number; message: string }
  | { type: 'LOG';  stepId: number; level: string; args: string[] }
```

`JestInstrumentedRunner` reads the temp file, parses all events in order, and builds the `TimelineStore`. The webview never sees raw events — it only receives the fully assembled store.

---

## 12. Playback Modes

### Replay mode (MVP)

Test runs to completion. `JestInstrumentedRunner` reads the full event file. `TimelineStore` is assembled and sent to the webview in one message. `PlaybackEngine` has all steps available from the start.

### Live mode (future)

Events stream from the runner to the webview as the test runs. `PlaybackEngine` receives steps incrementally; the timeline bar grows in real time. Message type: `timeline-event-stream` (stubbed, not wired in MVP).

---

## 13. Data Flow

```
User clicks ⏱ Timeline
  → liveTestRunner.openTimelineDebugger({ filePath, testFullName })
      → extension.ts sends { type: 'route', view: 'timeline' } to ResultsView
      → extension.ts sends { type: 'route', view: 'timelineSidebar' } to ExplorerView
      → ResultsView router mounts timelineView.js into #app (shows loading state)
      → ExplorerView router mounts timelineSidebar.js into #app
      → JestInstrumentedRunner.run({ filePath, testFullName, projectRoot })
          → Custom Jest transform injects __trace calls
          → Executor.ts spawns Jest --testNamePattern <testFullName>
          → __trace events written to temp file during run
          → JestInstrumentedRunner reads temp file, parses events → TimelineStore
      → extension.ts sends { type: 'timeline-ready', store: TimelineStore } to ResultsView
      → timelineView.js receives store → PlaybackEngine instantiated with store
      → PlaybackEngine sets currentStepId = 0, renders initial state

User scrubs / steps / plays
      → PlaybackEngine updates currentStepId
      → Timeline bar pointer moves, context label updates
      → Sidebar State panel updates from store.variables[currentStepId]
      → Console panel updates from store.logs[0..currentStepId]
      → Extension host receives { type: 'step-changed', stepId, filePath, line }
      → Extension host highlights line in VS Code editor

User clicks Re-run
      → timelineSidebar.js sends { type: 'rerun' } to extension host
      → extension.ts calls JestInstrumentedRunner.run() again
      → ResultsView shows loading state
      → On completion: new TimelineStore sent, PlaybackEngine re-instantiated

User exits timeline mode (closes debugger or session ends)
      → extension.ts sends { type: 'route', view: 'results', payload } to ResultsView
      → extension.ts sends { type: 'route', view: 'testList', payload } to ExplorerView
      → Routers unmount timeline views, mount normal views
      → TimelineStore cleared from memory
```

---

## 14. Webview Message Reference

### Extension host → ResultsView

| Type | Payload | Effect |
|---|---|---|
| `route` | `{ view: 'timeline' \| 'results', payload }` | Router switches active view |
| `timeline-ready` | `{ store: TimelineStore }` | `PlaybackEngine` receives full store, renders |
| `timeline-loading` | — | Shows loading/spinner state in timeline view |

### Extension host → ExplorerView

| Type | Payload | Effect |
|---|---|---|
| `route` | `{ view: 'timelineSidebar' \| 'testList', payload }` | Router switches active view |

### Webview → Extension host

| Type | Payload | Source | Effect |
|---|---|---|---|
| `step-changed` | `{ stepId, filePath, line }` | `PlaybackEngine` | Host highlights line in editor |
| `rerun` | — | Sidebar re-run button | Host calls `JestInstrumentedRunner.run()` again |
| `expand-node` | `{ stepId, name, path }` | State/Watch panel | Host resolves children for that node, sends back |

---

## 15. Performance Rules

| Rule | Detail |
|---|---|
| No deep serialisation at capture time | Shallow snapshots only; expand lazily |
| Virtualise timeline bar | Only render visible boxes in DOM |
| Virtualise large object/array trees | Only render visible nodes |
| Throttle live drag updates | ~50–100ms interval |
| No editor update during fast drag | Defer to release |
| `TimelineStore` immutable per step | No recomputation between steps |
| No external libraries | Custom serialiser, custom virtual renderer |
| `PlaybackEngine` in webview | No round-trips for playback; only `step-changed` crosses the boundary |

---

## 16. Extension Contributions (package.json)

Only one new entry required — the command. No new panel, no new view, no new configuration.

```jsonc
{
  "command": "liveTestRunner.openTimelineDebugger",
  "title": "Open Timeline Debugger",
  "category": "Live Test Runner"
}
```

The debugger reuses the existing `projectRoot` and `jestCommand` settings.

---

## 17. How Instrumentation Affects Existing Features

The instrumented pass is separate from all normal runs. Nothing about the on-save run, warm-up run, or `ResultStore` changes. But the richer data from instrumentation enables improvements that are only active in timeline mode.

### Line numbers

Normal runs populate `LineMap` from `location.line` in Jest JSON — one entry per `it`/`test` declaration. In timeline mode, every executed line is known from instrumentation. The editor can show a step indicator on every executed line, not just the `it` declaration.

### Console log attribution

Normal runs attribute all console output to the file. In timeline mode, every log is attributed to its exact step and line. The console panel shows `step N ·` labels per entry.

### What does NOT change in normal mode

All of the above applies only in timeline mode. Normal runs are untouched.

---

## 18. Rules That Must Not Be Broken

1. **`JestInstrumentedRunner` does not modify test files on disk.** Instrumentation is injected via Jest transform only.
2. **`TimelineStore` is separate from `ResultStore`.** Never write timeline data into `ResultStore`.
3. **The existing session is not affected.** `SessionManager`, `JestRunner`, and `ResultStore` behave identically whether or not the debugger is open.
4. **No deep serialisation at capture time.** Shallow snapshots only; expand lazily.
5. **No external libraries** for serialisation, virtualisation, or tree rendering.
6. **Circular references must not crash the serialiser.** Detect visited refs; replace with `[Circular]`.
7. **`PlaybackEngine` owns playback state.** The extension host never drives step changes — it only reacts to `step-changed` messages.
8. **The router always leaves the webview in a clean state.** Unmount is called before mounting a new view. No orphaned DOM, no orphaned event listeners.
9. **`ResultsView` and `ExplorerView` return to their normal views when the debugger closes.** Existing test results must be fully intact.
10. **Console and error panels in timeline mode are scoped to the single debugged test only.**
11. **`extension.ts` holds a reference to `IInstrumentedRunner`, never to `JestInstrumentedRunner` directly.** Framework-agnostic at the call site.

---

## 19. Future Roadmap

| Item | Notes |
|---|---|
| Live mode streaming | `PlaybackEngine` receives steps incrementally; message type stubbed |
| Frontend UI preview | Preview pane in editor section; shows component state at current step |
| Frontend event tracking | Capture `onChange`, `onBlur`, `submit`; map to timeline steps |
| Vitest support | New `VitestInstrumentedRunner implements IInstrumentedRunner` |
| Mocha support | New `MochaInstrumentedRunner implements IInstrumentedRunner` |
| Value mutation mid-timeline | User edits a variable value at a step; test re-runs from that point with the mutated value |
| Session persistence | Save/reload `TimelineStore` to `.vscode/live-test-runner/timeline-sessions/` |
| Loop step expansion | Expand compressed loop groups to see all iterations |
| CI integration | Export `TimelineStore` as build artifact |
| AI debugging | Surface suggestions based on variable history and failure messages |

---

## 20. Open Questions

All questions resolved. See below.

### Resolved

**`__trace` event transport — temp file.**
`traceRuntime.js` writes JSON lines to a temp file path passed via `process.env.TRACE_OUTPUT_FILE`. `JestInstrumentedRunner` reads the file after Jest exits. Same pattern as `Executor.ts` using `--outputFile` for Jest JSON. No IPC, no stdout parsing. If a single test produces an extreme number of steps (tight loop with 50,000+ iterations), a `maxTraceSteps` cap and loop-compression at the capture level can be added — not needed for MVP.

**Editor highlight and inline values — VS Code `TextEditorDecorationType`.**
The VS Code editor and the Results panel are separate VS Code panes — always have been. The timeline panel controls the editor from the extension host exactly as the existing Results panel does today: `vscode.window.showTextDocument` to open the file at the right line, `TextEditorDecorationType` for the line highlight and inline ghost text via `renderOptions.after`. No webview code mirror, no custom editor component. For the future UI preview pane, a horizontal editor split will be requested via the VS Code API when a UI component is available to show alongside the code.

**Call stack reconstruction — derived from `TimelineStore.steps`, no `Error.stack`.**
The call stack panel in the timeline sidebar does not use `Error.stack` or require any additional instrumentation. It is derived entirely from the `STEP` events already captured — specifically the `file` and `functionName` fields on each step up to and including `currentStepId`. Steps are grouped by file and displayed as a collapsible list, with each entry showing the function name and line number. Clicking an entry opens that file at that line via `vscode.window.showTextDocument`. This gives a richer view than a traditional call stack — it shows the full journey of execution up to the current step, not just the frozen frame at one moment.

---

*Last updated: v4 — all open questions resolved.*
