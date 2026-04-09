# Test Timeline Debugger — Build Tasks

> **Read this before writing a single line of code.**

## Standing Instructions

**The codebase may have evolved past what the spec describes.**
When you encounter code, patterns, or structure that differ from the spec, do not change existing behaviour to match the spec. The spec describes intent and new additions — not a mandate to refactor working code.

**If you encounter a conflict between the spec and existing code:**
Stop. Do not guess. Ask:
> "I found [existing thing] which differs from the spec in [specific way]. Should I adapt the new code to fit what's already here, or should we discuss changing the existing approach?"

Wait for an answer before proceeding.

**The same rule applies to file structure, naming conventions, message formats, and build config.**
If the project already does something a particular way, follow that way unless explicitly told otherwise.

---

## How to use this task list

- Work through tasks **in order**. Each task builds on the previous one.
- Complete one task fully before starting the next.
- Each task has **acceptance criteria** — do not mark a task done until all criteria pass.
- When a task says "no UI", it means no webview changes at all in that task.
- Reference the spec (`test-timeline-debugger-living-spec-v4.md`) for detail on any area. Reference `ai-context.md` and `architecture.md` for how the existing extension works.

---

## Task 1 — Define `IInstrumentedRunner` and `TimelineStore`

**What:** Create the two core TypeScript contracts that everything else depends on. No logic, no Jest, no UI.

**Files to create:**
- `packages/vscode-extension/src/timeline/IInstrumentedRunner.ts`
- `packages/vscode-extension/src/timeline/TimelineStore.ts`

**`TimelineStore.ts`** — export all interfaces: `TimelineStore`, `Step`, `VariableSnapshot`, `LogEntry`, `ErrorEntry`.

**`IInstrumentedRunner.ts`** — export the interface:
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

**Acceptance criteria:**
- Both files compile with no errors
- No other files are modified
- No logic, no classes — interfaces and types only

---

## Task 2 — Event system types

**What:** Define the `TimelineEvent` union type that the instrumentation layer emits and `JestInstrumentedRunner` will consume. No logic yet.

**Files to create:**
- `packages/vscode-extension/src/timeline/TimelineEvent.ts`

Export the full union type as specified in spec section 11.

**Acceptance criteria:**
- File compiles with no errors
- `VariableSnapshot` is imported from `TimelineStore.ts` — not redefined
- No other files modified

---

## Task 3 — `JestInstrumentedRunner` skeleton

**What:** Create the Jest implementation of `IInstrumentedRunner`. Stub only — `run()` returns a hardcoded empty `TimelineStore`. No actual instrumentation or Jest spawning yet.

**Files to create:**
- `packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts`

**Rules:**
- `implements IInstrumentedRunner`
- `cancel()` is a no-op stub
- `run()` returns a `Promise<TimelineStore>` with empty `steps: []`, `variables: new Map()`, `logs: new Map()`, `errors: []`
- Reuses the existing `Executor.ts` import path — do not copy or re-implement it
- Does not modify any existing file

**Acceptance criteria:**
- Compiles with no errors
- `extension.ts` holds a reference typed as `IInstrumentedRunner`, not `JestInstrumentedRunner`
- No existing files modified

---

## Task 4 — `PlaybackEngine` (pure logic, no UI)

**What:** Create the `PlaybackEngine` class that will live in the webview. Because it is plain JS (not TypeScript compiled by tsc), create it as a well-structured vanilla JS class in the webview folder.

**Files to create:**
- `packages/vscode-extension/src/webview/timeline/PlaybackEngine.js`

**`PlaybackEngine`** must:
- Accept a `TimelineStore`-shaped object in its constructor
- Track `currentStepId` internally
- Expose: `next()`, `prev()`, `jumpTo(stepId)`, `play(onStep)`, `pause()`, `isPlaying()`
- `play(onStep)` calls `onStep(step)` at a fixed ~200ms interval, advancing one step at a time, stopping at the last step
- Emit nothing to the extension host directly — callers wire that up
- Have no dependencies on VS Code APIs or `postMessage`

**Acceptance criteria:**
- Can be instantiated and exercised in a plain Node.js script (write a quick smoke test — 5 lines, not a full test suite)
- `play()` calls the callback at the right cadence
- `pause()` stops it cleanly
- `jumpTo()` clamps to valid range (no negative, no beyond last step)
- No existing files modified

---

## Task 5 — Webview router

**What:** Add a minimal JS router to both `ResultsView` and `ExplorerView` webviews. This is the routing shell — views are stubs at this stage.

**Files to create:**
- `packages/vscode-extension/src/webview/router.js` — shared router logic
- `packages/vscode-extension/src/webview/views/timelineView.js` — stub: mounts a `<p>Timeline view — coming soon</p>`
- `packages/vscode-extension/src/webview/views/timelineSidebar.js` — stub: mounts a `<p>Timeline sidebar — coming soon</p>`

**Files to modify:**
- `packages/vscode-extension/src/webview/results.html` — add router script, add `<div id="app">`, wrap existing content in a `resultsView.js` module
- `packages/vscode-extension/src/webview/explorer.html` — same pattern

**Rules:**
- The existing `results.html` layout and `explorer.html` layout must continue to work exactly as before — the default route on load is the existing view
- Router responds to `{ type: 'route', view: '...' }` messages from the extension host
- If you are unsure how the existing HTML is structured, read it fully before touching it. If the existing structure conflicts with this approach, stop and ask before proceeding.

**Acceptance criteria:**
- Existing `ResultsView` and `ExplorerView` behaviour is unchanged
- Sending `{ type: 'route', view: 'timeline' }` from extension host switches `results.html` to show the timeline stub
- Sending `{ type: 'route', view: 'results' }` switches back
- Same for explorer with `timelineSidebar` / `testList`
- No visual regressions in normal test results display

---

## Task 6 — New command and entry points

**What:** Register the `liveTestRunner.openTimelineDebugger` command. Wire the CodeLens and ExplorerView buttons. Route both webviews on activation. Do not run any instrumented Jest yet — just route to the stub views.

**Files to modify:**
- `packages/vscode-extension/package.json` — add the new command
- `packages/vscode-extension/src/extension.ts` — register command, instantiate `JestInstrumentedRunner` typed as `IInstrumentedRunner`
- `packages/vscode-extension/src/editor/CodeLensProvider.ts` — add `⏱ Timeline` lens on `it`/`test` lines
- `packages/vscode-extension/src/views/ExplorerView.ts` — add Timeline button per test row

**Rules:**
- The command handler sends `{ type: 'route', view: 'timeline' }` to `ResultsView` and `{ type: 'route', view: 'timelineSidebar' }` to `ExplorerView`
- It does NOT call `JestInstrumentedRunner.run()` yet
- `extension.ts` must reference `IInstrumentedRunner`, not the concrete class
- Read the existing `CodeLensProvider.ts` and `ExplorerView.ts` fully before modifying. If the existing patterns differ from what the spec assumes, ask before proceeding.

**Acceptance criteria:**
- `⏱ Timeline` CodeLens appears on `it`/`test` lines during an active session
- Timeline button appears per test row in ExplorerView
- Clicking either routes both panels to their stub views
- Existing `▶ Run` and `▷ Debug` lenses are unaffected
- Existing ExplorerView test list behaviour is unaffected

---

## Task 7 — Shared `logPanel.js` and `errorPanel.js` components

**What:** Extract the existing log output (column 2) and error output (column 3) rendering from `ResultsView` into standalone shared components. The existing `ResultsView` must use these components and behave identically. The timeline view will use them later.

**Files to create:**
- `packages/vscode-extension/src/webview/components/logPanel.js`
- `packages/vscode-extension/src/webview/components/errorPanel.js`

Each component exports `{ mount(container, payload), update(container, payload), unmount(container) }`.

**Files to modify:**
- `packages/vscode-extension/src/webview/views/resultsView.js` (or equivalent existing file) — import and use the new components instead of inline rendering

**Rules:**
- Read the existing results webview code in full before touching it
- The existing `ResultsView` must look and behave exactly as before after this refactor
- If the existing code structure makes a clean extraction difficult, stop and ask before proceeding

**Acceptance criteria:**
- `ResultsView` in normal mode looks and behaves identically to before
- `logPanel.js` and `errorPanel.js` exist as standalone importable modules
- No regressions in log display, error display, filtering, or scoping

---

## Task 8 — `TimelineStore` builder in `JestInstrumentedRunner`

**What:** Implement the actual event parsing in `JestInstrumentedRunner`. Read a temp file of `TimelineEvent` JSON lines and build a real `TimelineStore`. No Jest spawning yet — test this against a hand-written fixture event file.

**Files to modify:**
- `packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts`

**Files to create:**
- `packages/vscode-extension/src/timeline/__fixtures__/sample-events.jsonl` — hand-written fixture with a realistic sequence of STEP, VAR, LOG, ERROR events for a simple test

**What to implement:**
- A `parseEvents(filePath: string): TimelineStore` method (private)
- Reads the file line by line, parses each as a `TimelineEvent`, builds the store
- `run()` still returns the hardcoded stub — wiring to actual Jest spawning comes in task 10

**Acceptance criteria:**
- `parseEvents` correctly builds `steps[]`, `variables Map`, `logs Map`, `errors[]` from the fixture file
- A simple manual test (or a real unit test if the project has a test runner set up for the extension) verifies this
- No existing files modified beyond `JestInstrumentedRunner.ts`

---

## Task 9 — Custom Jest transform for instrumentation

**What:** Implement the code transform that injects `__trace.*` calls into a test file at run time. This is the most complex task — take it carefully.

**Files to create:**
- `packages/vscode-extension/src/timeline/instrumentation/traceTransform.js` — Jest-compatible transform (CommonJS; Jest transforms must be CJS)
- `packages/vscode-extension/src/timeline/instrumentation/traceRuntime.js` — the `__trace` global that emits events to the temp file

**`traceTransform.js`** — implements Jest's `process(sourceCode, sourcePath)` interface. Injects `__trace.step(stepId, line, file, fn)` before each statement and `__trace.var(stepId, name, value)` after assignments. Does not modify test files on disk.

**`traceRuntime.js`** — implements `__trace.*`. Reads the output temp file path from `process.env.TRACE_OUTPUT_FILE`. Writes each event as a JSON line to that file synchronously (to avoid async ordering issues).

**Rules:**
- No AST library. Use regex-based line injection for MVP — it does not need to handle every JS construct, only the common patterns found in unit tests
- If you find a case where regex is genuinely insufficient and an AST is required, stop and ask before adding a dependency
- The transform must not affect files outside the target test file

**Acceptance criteria:**
- Given a simple input file with variable assignments and function calls, the transform output contains `__trace.step` and `__trace.var` calls
- `traceRuntime.js` writes correctly formatted `TimelineEvent` JSON lines to the specified file
- Circular references in variable values do not crash `traceRuntime.js` — they produce `"[Circular]"`

---

## Task 10 — Wire `JestInstrumentedRunner.run()` end to end

**What:** Connect the transform, the runtime, and `Executor.ts` so a real Jest run produces a real `TimelineStore`.

**Files to modify:**
- `packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts`

**What to implement:**
- `run()` now:
  1. Creates a temp file path for trace output
  2. Writes a temporary Jest config that adds `traceTransform.js` to the transform chain
  3. Sets `TRACE_OUTPUT_FILE` env var
  4. Calls `Executor.ts` (reuse as-is) with `--testNamePattern` and the temp config
  5. On Jest exit, calls `parseEvents(tempFilePath)`
  6. Returns the `TimelineStore`
- `cancel()` kills the child process via whatever mechanism `Executor.ts` exposes

**Rules:**
- Do not modify `Executor.ts`
- If `Executor.ts` does not expose a cancel/kill mechanism, stop and ask before adding one

**Acceptance criteria:**
- Pointing `run()` at a real test file and test name in `ibuy-frontend-sample` produces a non-empty `TimelineStore`
- `steps[]` contains at least one entry per executed line
- `logs` map contains entries for any `console.log` calls in the test
- Cancel stops the child process cleanly

---

## Task 11 — Send `TimelineStore` to webview and render basic timeline bar

**What:** After `run()` completes, send the store to `ResultsView` and render the timeline boxes. No sidebar, no console panel, no editor highlight yet — just the timeline bar and controls.

**Files to modify:**
- `packages/vscode-extension/src/extension.ts` — call `run()`, send result to `ResultsView`
- `packages/vscode-extension/src/webview/views/timelineView.js` — replace stub with real timeline bar render

**`timelineView.js`** must:
- Receive the `TimelineStore` via `{ type: 'timeline-ready', store }` message
- Instantiate `PlaybackEngine` with the store
- Render the timeline boxes (one per step at default zoom)
- Show the context label above boxes: `filename · functionName · line N`
- Render the playback controls (⏮ ◀ ▶ ▶| ⏭ ⏸) centred below boxes
- Wire controls to `PlaybackEngine`
- On each step change, send `{ type: 'step-changed', stepId, filePath, line }` to extension host
- Show a loading state while `run()` is in progress

**Extension host** receives `step-changed` and logs it to console for now (editor highlight comes in task 13).

**Acceptance criteria:**
- Running the debugger on a real test shows a timeline bar with boxes
- Controls step through the timeline correctly
- Context label updates on each step
- Active box is visually distinct (accent colour)
- Error steps have red tint
- Loading state shows while Jest is running

---

## Task 12 — Sidebar: State, Watch, Call Stack

**What:** Implement the timeline sidebar view in `ExplorerView`.

**Files to modify:**
- `packages/vscode-extension/src/webview/views/timelineSidebar.js` — replace stub with real sidebar

**Sidebar must:**
- Show test name at top
- Show Re-run button — sends `{ type: 'rerun' }` to extension host
- Show State section: variables at `store.variables[currentStepId]`, lazy expandable
- Show Watch section: `+ add variable` input, list of watched variables with values at current step
- Show Call Stack section: function chain at current step, clickable entries

**Extension host** receives `rerun` and calls `JestInstrumentedRunner.run()` again, sends new store on completion.

**Sync:** When `PlaybackEngine` steps (in `ResultsView` webview), the extension host receives `step-changed` and forwards `{ type: 'step-update', stepId }` to `ExplorerView` so the sidebar updates its State and Watch panels.

**Acceptance criteria:**
- State panel shows correct variables for the current step
- Expanding an object node shows its top-level keys
- Watch panel accepts a variable name and shows its value at current step
- Call stack entries are clickable (send `{ type: 'open-file', filePath, line }` — existing handler)
- Re-run button triggers a fresh instrumented run

---

## Task 13 — Editor highlight on step change

**What:** When the extension host receives `step-changed`, highlight that line in the active VS Code editor using a dedicated decoration type.

**Files to modify:**
- `packages/vscode-extension/src/extension.ts` or a new `TimelineDecorationManager.ts`

**Rules:**
- Use a new `TextEditorDecorationType` separate from the existing pass/fail decorations in `DecorationManager`
- If the step is in a different file than the current editor, open that file then apply the decoration
- Clear the decoration when the debugger closes (route back to normal view)
- Do not modify `DecorationManager.ts` — create a separate class

**Acceptance criteria:**
- Active line is highlighted in the editor as the user steps through the timeline
- File switches correctly when steps cross file boundaries
- Decoration is cleared when exiting timeline mode
- Existing pass/fail gutter decorations are unaffected

---

## Task 14 — Console and Error panels

**What:** Wire the shared `logPanel.js` and `errorPanel.js` components into the timeline view's 25% right column.

**Files to modify:**
- `packages/vscode-extension/src/webview/views/timelineView.js`

**Console panel:**
- Uses `logPanel.js`
- Shows cumulative logs from `store.logs` up to and including `currentStepId`
- Prefixes each entry with `step N ·`
- Updates on every step change via `PlaybackEngine`

**Errors panel:**
- Uses `errorPanel.js`
- Shows all `store.errors` — static, does not change per step
- Populated on `timeline-ready`

**Acceptance criteria:**
- Console panel shows correct logs for current step position
- Switching to Errors tab shows failure output
- Auto-scrolls to latest log unless user has scrolled up
- Components look consistent with their appearance in normal `ResultsView`

---

## Task 15 — Editor inline values and hover

**What:** Show variable values as inline ghost text in the editor at the current step. Add hover popup with history and `[Add to Watch]`.

**Files to modify:**
- `packages/vscode-extension/src/extension.ts` or `TimelineDecorationManager.ts`

**Rules:**
- Use `renderOptions.after` on the line decoration (same mechanism as existing inline duration text)
- Show only the value at the current step inline
- Hover tooltip shows value history across steps and `[Add to Watch]` / `[Copy]` actions
- `[Add to Watch]` sends a message to `ExplorerView` to add the variable to the Watch panel
- Do not modify `DecorationManager.ts`

**Acceptance criteria:**
- Variable values appear as ghost text on relevant lines
- Values update as the user steps through the timeline
- Hover shows history
- `[Add to Watch]` adds the variable to the sidebar Watch section

---

## Task 16 — Drag behaviour and zoom

**What:** Implement timeline scrubbing (drag) with the correct fast/slow split, and zoom via mouse wheel / pinch.

**Files to modify:**
- `packages/vscode-extension/src/webview/views/timelineView.js`
- `packages/vscode-extension/src/webview/timeline/PlaybackEngine.js`

**Drag rules (from spec section 5.4):**
- Slow drag (~below a velocity threshold): update context label, editor, sidebar at ~50–100ms throttle
- Fast drag (above threshold): update context label only; defer editor and sidebar to release
- Release: full commit — send `step-changed`, update all panels

**Zoom rules:**
- Mouse wheel / pinch changes zoom level between: lines → functions → files
- At function zoom: group consecutive steps with the same `functionName` into one box
- At file zoom: group by `file`
- Max ~3 boxes visible at full zoom out; timeline scrolls at finer zoom levels

**Acceptance criteria:**
- Slow drag updates the editor in real time (throttled)
- Fast drag only updates context label until release
- Zoom out groups steps correctly
- Zoom in returns to line-level
- Context label always reflects the pointer position

---

## Task 17 — Loop compression

**What:** Detect consecutive steps that are part of a loop (same line repeating) and compress them into a single box when the iteration count exceeds 10.

**Files to modify:**
- `packages/vscode-extension/src/webview/views/timelineView.js`

**Rules:**
- Detect runs of steps at the same line number with count > 10
- Replace with a single box labelled `×N`
- The box is visually distinct (striped border or pattern)
- Clicking the box jumps to the last step in the group

**Acceptance criteria:**
- A test with a loop of 20+ iterations shows a compressed box, not 20+ individual boxes
- Clicking the compressed box navigates to the final iteration
- Non-loop steps are unaffected

---

## Task 18 — End-to-end smoke test on `ibuy-frontend-sample`

**What:** Run the full debugger on a real test in `ibuy-frontend-sample` and verify all pieces work together.

**Not a code task — a verification checklist:**

- [ ] Click `⏱ Timeline` CodeLens on a test in the project
- [ ] Loading state appears in the Results panel
- [ ] Timeline bar renders with correct step count
- [ ] Stepping forward moves the editor highlight
- [ ] Inline values appear and update per step
- [ ] Console panel shows logs at the correct steps
- [ ] Errors panel shows the failure message (use a failing test)
- [ ] Sidebar State shows variables at each step
- [ ] Watch panel accepts a variable name and tracks it
- [ ] Re-run button re-runs and refreshes all panels
- [ ] Exiting timeline mode (clicking a normal test row) returns `ResultsView` and `ExplorerView` to normal
- [ ] Normal on-save runs still work after using the timeline debugger

If any item fails, fix it before marking this task done. If fixing it requires changing existing extension behaviour, ask first.

---

*Tasks follow the build order from spec section 13 (Data Flow). Each task is independently testable. Do not skip tasks or combine them — the incremental approach is intentional.*

---

## Task 19 — Update all documentation

**What:** After Task 18 passes completely, update every documentation file to reflect the new feature. Do not do this task until the end-to-end smoke test is fully green.

**Files to update:**

### `ai-context.md` (project root)
- Add `TimelineStore.ts`, `IInstrumentedRunner.ts`, `JestInstrumentedRunner.ts`, `PlaybackEngine.js`, `traceTransform.js`, `traceRuntime.js` to the key files table with their purpose
- Add `timeline/` to the `packages/vscode-extension/src/` directory tree
- Add `timeline-mode-start`, `timeline-mode-end`, `route`, `timeline-ready`, `timeline-loading`, `step-changed`, `rerun`, `expand-node` to the webview messaging table
- Add the `liveTestRunner.openTimelineDebugger` command to the VS Code contribution points section
- Add `IInstrumentedRunner` / framework adaptability to the rules section

### `architecture.md` (project root)
- Add the Timeline Debugger to the VS Code layout diagram (what lives where)
- Add `IInstrumentedRunner`, `JestInstrumentedRunner`, `TimelineStore`, `PlaybackEngine` to the package overview
- Add the webview router pattern to the webview section — explain that both webviews use a JS router with `mount`/`unmount` per view
- Add the shared component pattern (`logPanel.js`, `errorPanel.js`) to the webview section
- Add the `step-changed` boundary rule (playback in webview, editor highlight in host) to the key design decisions table

### `developer-guide.md` (project root)
- Add a "Using the Timeline Debugger" section explaining how to activate it from CodeLens and ExplorerView
- Add a "Adding a new instrumented framework" section — mirrors the existing "Adding a new framework" section but for `IInstrumentedRunner`
- Add `PlaybackEngine`, the router pattern, and the shared component pattern to the Core patterns section
- Add `traceTransform.js` and `traceRuntime.js` to the known limitations section if any edge cases were found during development

### `packages/vscode-extension/README.md` (user-facing, shown on VS Code Marketplace)
- Add the Timeline Debugger to the features list with a clear one-paragraph description of what it does
- Add activation instructions: how to trigger it from CodeLens (`⏱ Timeline`) and from the sidebar
- Add a short explanation of the sidebar panels (State, Watch, Call Stack) and timeline controls
- Keep the tone consistent with the existing README — user-facing, not technical

### Root `README.md`
- Add the Timeline Debugger to the feature overview
- Link to the extension README for full details

### `CHANGELOG.md` (project root)
- Add a new version entry at the top (bump the patch or minor version as appropriate for the project's current versioning)
- List under the new version:
  - `Added: Test Timeline Debugger — step-by-step replay of individual test cases`
  - `Added: ⏱ Timeline CodeLens on it/test lines`
  - `Added: Timeline button per test row in the Explorer sidebar`
  - `Added: State, Watch, and Call Stack panels in timeline mode`
  - `Added: Console and Error panels scoped to the debugged test`
  - `Added: IInstrumentedRunner interface for future framework support`

**Rules:**
- Do not rewrite sections that are already accurate — add to them
- Do not change the tone or structure of any existing document — match what is already there
- If a document uses a particular heading style, list style, or table format, follow it exactly
- If you are unsure whether something has changed enough to warrant updating a doc section, include it — over-documenting is better than under-documenting here

**Acceptance criteria:**
- All six documents updated
- `ai-context.md` key files table includes all new files
- `architecture.md` design decisions table includes the `step-changed` boundary rule
- Extension `README.md` explains the feature clearly to a user who has never seen the spec
- `CHANGELOG.md` has a new version entry at the top
- No existing content in any document has been removed or reworded without good reason
