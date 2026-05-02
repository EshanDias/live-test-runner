# Timeline Debugger — Feature Plan

> Branch: `feat/eshan/timeline`  
> Status: Decisions locked — ready for implementation  
> Date: 2026-05-02

---

## Design Priority Note

Previous development on this branch built some infrastructure that may still be useful at the code level (instrumentation pipeline, event types, decoration manager), but the **design decisions in this document take full priority**. The old approach auto-traced all files at session start. The new approach is **explicit and on-demand** — nothing runs until the user asks for it.

---

## What Already Exists (Reusable Code)

| File | Status |
|------|--------|
| `src/timeline/TimelineEvent.ts` | Keep — update event types to match new patch model |
| `src/timeline/TimelineStore.ts` | Keep — update to reflect two-file model |
| `src/timeline/JestInstrumentedRunner.ts` | Keep — update wiring to StorageManager |
| `src/timeline/TimelineDecorationManager.ts` | Keep — re-wire to new flow |
| `src/timeline/IInstrumentedRunner.ts` | Keep |
| `src/timeline/instrumentation/traceTransform.js` | Keep — add declaration-line tracking for variable keys |
| `src/timeline/instrumentation/traceRuntime.js` | Rewrite capture logic — replace snapshot model with delta-patch model |
| `src/views/ExplorerView.ts` | Keep — timeline sidebar routing already wired |
| `src/views/ResultsView.ts` | Keep — timeline panel routing already wired |

**Remove:** any auto-trace or session-start trace collection — conflicts with on-demand design.

---

## Feature Overview

The Timeline Debugger lets a user step through a single test's execution line by line, seeing exactly what variables held at each step, what was logged, and where failures occurred. It is a **local, replay-based debugger** — no debugger protocol, no breakpoints.

Everything is **on-demand and user-initiated**. Nothing collects data in the background.

---

## Entry Points

### 1. CodeLens on test lines (`⏱ Timeline`)

Each `it()` / `test()` line has a `⏱ Timeline` CodeLens button. Clicking it calls:

```
liveTestRunner.openTimelineDebugger(filePath, testFullName)
```

This opens the timeline panel and sidebar. If trace data already exists for this test, it loads immediately. If not, the panel shows the empty state with the Collect button.

### 2. Collect / Recollect button in the timeline panel

- **No data exists** → button label: `Collect Timeline`
- **Data already exists** → data loads immediately on panel open; button label changes to `Recollect` (smaller, top-right of panel header)
- **Tooltip on both:** `"Runs this test file with instrumentation to collect step-by-step execution data"`

Collecting always runs the **full test file** — so all tests in the file get trace data in one pass. The first collect populates data for every test in the file simultaneously.

---

## UI Layout

### Timeline Panel (Panel › Test Results)

```
┌─ Timeline Panel ────────────────────────────────────────┐
│  [ should login with valid credentials    ▾ ]           │
│  [ Test ]  [ Suite ]                [ Recollect ]       │
│  ─────────────────────────────────────────────────────  │
│  [████████░░░░░░░░░░░░░]  step 34 / 87                  │
│  [ |◀ ]  [ ◀ ]  [ ▶/⏸ ]  [ ▶ ]  [ ▶| ]               │
│                                                         │
│  Console / Errors                                       │
│  ─────────────────────────────────────────────────────  │
│  log  "starting auth"                                   │
│  ✗  Expected true, got false                            │
└─────────────────────────────────────────────────────────┘
```

**Test picker dropdown** — lists all tests in the current file. No indicators on individual tests (data is file-level, not per-test). Selecting a test with data loads it. Selecting one without data shows the empty state and Collect button.

**Scope tabs** — `Test` (default) and `Suite`. Display filter only — does not affect what was collected. Switching is instant.

**Step bar + playback controls** — visible only after data is loaded.

**Console / Errors** — scoped to the current step. Shows `console.log` output and assertion failures at that step.

### Timeline Sidebar (Primary Sidebar)

```
┌─ Timeline Sidebar ──────────┐
│  State                      │
│    car@8    Vehicle {}      │
│      .engine  "V8"          │
│      .speed   60            │
│    token@15  "abc123"       │
│  ───────────────────────    │
│  Watch                      │
│    (empty)                  │
└─────────────────────────────┘
```

**State** — reconstructed variable values at the current step. Updates on every step change.

**Watch** — user-pinned variable names. Persists as the user steps through. Shows current value at each step.

No Call Stack panel — the single `functionName` field on STEP events is not enough to build a meaningful call stack. Can be added in a future version if proper entry/exit tracking is added to the instrumentation.

### Empty state (no data collected yet)

```
┌─ Timeline Panel ────────────────────────────────────────┐
│  [ should login with valid credentials    ▾ ]           │
│  [ Test ]  [ Suite ]                                    │
│                                                         │
│         ┌──────────────────────────────┐                │
│         │  ⏱  Collect Timeline        │                │
│         └──────────────────────────────┘                │
│         Runs this test file with instrumentation        │
│         to collect step-by-step execution data.         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Scope: Test and Suite

| Scope | What's shown |
|-------|-------------|
| **Test** (default) | Only steps inside the selected `it()` / `test()` block |
| **Suite** | Steps inside the `describe` block containing the test, including `beforeEach` / `afterEach` hooks that run for it |

File scope is not included. Showing an entire file's timeline would combine steps from all tests in sequence — variables from unrelated tests would bleed together and the timeline would be incoherent. Suite is the right upper boundary: it answers the real question ("what did `beforeEach` do to my variables?") without the noise.

Scope is a **display filter only** — the full file always runs during collection. Switching scope costs nothing.

---

## Storage Model

### File structure per test

```
<session-tmp-dir>/
├── <normal session data>
└── timeline/
    └── <test-file-slug>/           e.g. "auth-test-ts"
        └── <test-name-slug>/       e.g. "should-login-with-valid-credentials"
            ├── steps.jsonl
            ├── vars.jsonl
            └── index.json
```

Slugs: non-alphanumeric characters replaced with `-`, truncated to safe length. Re-collecting overwrites all three files for every test in the file.

Timeline data is **session-scoped** — lives in the session temp dir, cleaned up automatically when the session ends (same PID-based cleanup as the rest of the session). No data survives session restart.

### `steps.jsonl` — one line per step

Every statement that executes produces one line. Short keys minimise size:

```jsonl
{"s":1,"l":5,"f":"vehicle.test.ts","fn":"should create vehicle"}
{"s":2,"l":6,"f":"vehicle.test.ts","fn":"should create vehicle"}
{"s":3,"l":8,"f":"vehicle.test.ts","fn":"constructor"}
```

Keys: `s`=stepId, `l`=line, `f`=file, `fn`=functionName. A 1000-step test is ~80 KB.

### `vars.jsonl` — delta patches only

Variable entries written **only when a value changes**. Only the changed part of the object is written — not the whole object.

**Variable key:** `name@declarationLine` (e.g. `car@8`, `result@23`). Unique across scopes because no two declarations share a line. Two variables with the same name in different scopes get different keys and appear as separate entries in the State panel. If names collide in the display, a `line N` badge is shown on the second one.

**Patch operations:**

```jsonl
// First appearance — full snapshot (root set, path=[])
{"s":3,"n":"car@8","op":"set","p":[],"v":{"__class":"Vehicle","engine":"V8","speed":0,"wheels":[{"size":18,"worn":false},{"size":18,"worn":false}]}}

// Only car.speed changed
{"s":45,"n":"car@8","op":"set","p":["speed"],"v":60}

// Nested field changed
{"s":67,"n":"car@8","op":"set","p":["wheels","0","worn"],"v":true}

// New field added
{"s":89,"n":"car@8","op":"set","p":["temp"],"v":"debug"}

// Field deleted
{"s":92,"n":"car@8","op":"del","p":["temp"]}

// Array replaced (arrays always re-snapshotted in full when changed)
{"s":120,"n":"car@8","op":"set","p":["wheels"],"v":[{"size":20,"worn":false},{"size":20,"worn":false},{"size":20,"worn":false}]}
```

**Checkpoint rule:** every 100 patches for a variable, write a new full root snapshot (`p:[]`) instead of another patch. This caps reconstruction cost at 100 patch applications regardless of test length.

**Diff logic in `traceRuntime.js`:** on every `__trace.var(stepId, name, currentValue)` call:
1. Variable is new → write `op:"set", p:[]` with full capture
2. Variable exists → `diff(previousValue, currentValue)` recursively by key → write only changed paths
3. If identical to previous → skip entirely (no write)
4. Store a deep copy of `currentValue` as the new previous
5. Patch count for this variable hits 100 → write a new root snapshot and reset count

Arrays are compared by full serialisation. If anything changed, re-snapshot the whole array.

**Capture bounds:**
- Primitives: full value, strings capped at 500 chars (`…` truncation indicator)
- Objects: full depth to 6 levels, beyond that → `"[object]"`
- Arrays: up to 100 items, then `"[…N more]"` — always re-snapshotted in full
- Class instances: `__class` field from `constructor.name` (shows `Vehicle {}` not `{}`)
- Circular references: `"[Circular]"` sentinel

### `index.json` — byte-offset index

Written after the run completes. Stores byte offsets for checkpoint entries (root snapshots) per variable so any position can be seeked to directly:

```json
{
  "steps": [
    { "stepId": 1,   "offset": 0     },
    { "stepId": 200, "offset": 9043  },
    { "stepId": 400, "offset": 18102 }
  ],
  "vars": {
    "car@8":    [{ "stepId": 3,   "offset": 0    },
                 { "stepId": 103, "offset": 8821 }],
    "token@15": [{ "stepId": 45,  "offset": 3201 }]
  }
}
```

Only checkpoint entries (root snapshots) are indexed. Patches between checkpoints are read sequentially from the checkpoint offset.

### Storage limits

| Limit | Value | When it applies |
|-------|-------|-----------------|
| Max stored test traces | 5 | Always |
| Max total timeline folder size | 50 MB | Only when more than 1 test file is stored |

A single test file's trace is never evicted for size alone. When evicting, delete the oldest trace folder (by mtime of `steps.jsonl`). Clean up empty parent folders.

**Storage manager:** `TimelineStorageManager.ts` — path construction, eviction, index generation, read/write.

---

## Variable Reconstruction at Step N

1. Load `index.json` (once, on timeline open)
2. For each variable: binary search checkpoint list → find nearest `stepId ≤ N`
3. Seek to that byte offset in `vars.jsonl`
4. Read and apply patches forward from that checkpoint to N — **max 100 patches**
5. Cache reconstructed state at step N in memory

**Forward stepping** (N → N+1): apply any new patches at N+1 to cached state. O(patches at that step).

**Backward or jump to unvisited step M**: find nearest checkpoint ≤ M, apply forward to M. Max 100 patches. No reverse patching — always rebuild forward from nearest checkpoint. Storing `prev` values for reverse patching would double storage with no meaningful benefit given the checkpoint cap.

**Cache hit**: revisiting any previously visited step is instant.

---

## Data Flow (End to End)

```
User clicks "⏱ Timeline" CodeLens
    → liveTestRunner.openTimelineDebugger(filePath, testFullName)
        → ResultsView: route to timeline view
        → ExplorerView: route to timelineSidebar view
        → TimelineStorageManager.exists(filePath, testFullName)?
            YES → load steps.jsonl + index.json → send timeline-ready → panel shows data
            NO  → panel shows empty state with "Collect Timeline" button

User clicks "Collect Timeline" (or "Recollect")
    → Webview sends { type: 'timeline-collect-requested' }
    → Extension host:
        → Panel enters loading state (spinner)
        → JestInstrumentedRunner.run({ filePath, projectRoot })
            → Spawns Jest with traceTransform for the full file
            → traceRuntime writes STEP events → steps.jsonl (per test folder)
            → traceRuntime writes VAR delta patches → vars.jsonl (checkpoint every 100)
            → Jest exits
        → TimelineStorageManager.save(...)
            → Writes all test folders for the file
            → Generates index.json with checkpoint byte offsets
            → Enforces 5-trace and 50 MB limits, evicts oldest if needed
        → Load selected test's data → send timeline-ready → panel shows data
        → Button changes to "Recollect"

User selects a different test from dropdown
    → TimelineStorageManager.load(filePath, newTestName) → already on disk → instant
    → Send timeline-ready with new test data

User steps through timeline (next / prev / scrub / play)
    → PlaybackEngine:
        → Reconstruct variable state at step N (cache → checkpoint → patches)
        → Cache result
    → Webview sends { type: 'step-changed', stepId, filePath, line }
    → Extension host:
        → TimelineDecorationManager.highlight(filePath, line)
        → Sends { type: 'step-update', variables } → ExplorerView sidebar (State panel)

User exits timeline mode
    → TimelineDecorationManager.clearAll()
    → ExplorerView: route back to normal explorer
    → ResultsView: route back to normal results
```

---

## What to Build

| Component | Action |
|-----------|--------|
| `traceRuntime.js` | Rewrite — delta-patch model, diff logic, checkpoint every 100 patches, declaration-line variable keys |
| `traceTransform.js` | Update — pass declaration line into `__trace.var()` calls |
| `TimelineStorageManager.ts` | New — three-file write, index generation, eviction, read, exists check |
| `TimelineEvent.ts` | Update — patch op types (`set`/`del`), `path`, declaration line |
| `TimelineStore.ts` | Update — reflect two-file model and index structure |
| `JestInstrumentedRunner.ts` | Update — run full file (not name-pattern filtered), hand output to StorageManager |
| Panel webview UI | Update — test picker dropdown, Test/Suite scope tabs, Collect/Recollect button, step bar, console/errors only (no variables — those are in the sidebar) |
| Sidebar webview UI | Update — State panel (variable tree with reconstruction), Watch panel |
| `TimelineDecorationManager.ts` | Re-wire — correct step data from new flow |
| Auto-trace / session-start trace | Remove |

---

## Implementation Tasks & Milestones

Each milestone ends with a **manual verification step** — something you can see or trigger in the running extension to confirm the work is correct before moving on.

Logging rule: every task adds structured log lines prefixed `[LTR-TIMELINE]` to the extension Output channel (`Raw output`). On any error, the full message + stack is logged so the user only needs to paste the raw output to diagnose.

---

### M1 — Data Collection Works End to End

**Goal:** Clicking "⏱ Timeline" opens the panel. Clicking "Collect Timeline" runs the file with instrumentation and writes the three files to disk. Nothing is displayed in the UI yet — this milestone is about the pipeline being correct.

---

#### T1.1 — Rewrite `traceRuntime.js` (delta-patch model)

**File:** `packages/vscode-extension/src/timeline/instrumentation/traceRuntime.js`

Replace the entire file. The new runtime must:

- Export `global.__trace` with `step(stepId, line, file, functionName)`, `var(stepId, declLine, name, value)`, `log(stepId, level, ...args)` methods
- Write to **two separate files** via env vars: `TRACE_STEPS_FILE` (steps) and `TRACE_VARS_FILE` (vars)
- `step()`: write `{"s":stepId,"l":line,"f":file,"fn":functionName}` to `TRACE_STEPS_FILE`
- `var()`: implement full diff logic — see below
- `log()`: write `{"s":stepId,"level":level,"args":[...]}` to `TRACE_STEPS_FILE` (same file as steps so ordering is preserved)

**Diff logic for `var()`:**

```
varKey = name + "@" + declLine
if varKey not seen before:
  capture full value (captureValue(value, 0))
  write {"s":stepId,"n":varKey,"op":"set","p":[],"v":capturedValue} to TRACE_VARS_FILE
  store deep copy as previousValue[varKey]
  patchCount[varKey] = 1
  return
diff = computeDiff(previousValue[varKey], currentValue)
if diff is empty: return (no write — value unchanged)
if patchCount[varKey] >= 100:
  write full root snapshot (op:"set", p:[])
  reset patchCount[varKey] = 1
else:
  write each diff entry as a patch line
  patchCount[varKey] += diff.length
store deep copy of currentValue as previousValue[varKey]
```

**`captureValue(value, depth)`:**
- `null` → `null`
- primitives → raw value; strings capped at 500 chars with `"…"` appended if truncated
- circular ref (detected with a `WeakSet` passed through recursion) → `"[Circular]"`
- arrays: if `depth >= 6` → `"[object]"`; else capture items 0–99 as `captureValue(item, depth+1)`, if more than 100 items append `"[…N more]"` as last element; always re-snapshot in full (no diffing arrays)
- objects: if `depth >= 6` → `"[object]"`; else for each enumerable key call `captureValue(v, depth+1)`; add `__class: constructor.name` if `constructor.name` exists and is not `"Object"`

**`computeDiff(prev, curr)`** — returns array of patch ops:
- If `prev` and `curr` are both plain objects (not arrays, not null): diff key by key recursively; collect `{op:"set",p:[...path],v:capturedValue}` for added/changed keys; collect `{op:"del",p:[...path]}` for removed keys
- If either is an array or a primitive or types differ: emit one `{op:"set",p:[...currentPath],v:captureValue(curr,0)}` (full re-snapshot at that path)
- Return empty array if identical by `JSON.stringify` comparison first (fast path)

**Logging:** every write error caught by try/catch logs `[LTR-RUNTIME] write error: <message>` to `process.stderr`. Never throw — tracing must never crash the test.

---

#### T1.2 — Update `traceTransform.js` (pass declaration line)

**File:** `packages/vscode-extension/src/timeline/instrumentation/traceTransform.js`

**Change only `makeVarCall`** — add the declaration line number as the second argument:

```js
// Before:
__trace.var(stepId, varName, value)

// After:
__trace.var(stepId, declLine, varName, value)
```

Where `declLine` is `node.loc.start.line` from the `VariableDeclaration` node (same line number already used for the `makeStepCall`).

Also update the regex fallback section: extract `declLine` from the loop's `i + 1` position and pass it.

No other changes to `traceTransform.js`.

---

#### T1.3 — Create `TimelineStorageManager.ts`

**File:** `packages/vscode-extension/src/timeline/TimelineStorageManager.ts`

New class. Responsibilities:

**Path construction:**
```ts
slug(s: string): string  // replace non-alphanumeric with "-", truncate to 60 chars
testDir(filePath: string, testName: string): string
// returns: <sessionTmpDir>/timeline/<fileSlug>/<testSlug>/
```

**`exists(filePath, testName): boolean`**  
Returns true if `<testDir>/steps.jsonl` exists.

**`save(filePath: string, rawStepsPath: string, rawVarsPath: string, testNames: string[]): Promise<void>`**  
Called after Jest exits. For each test name in `testNames`:
1. Create `<testDir>/`
2. Move (or copy+delete) the raw `steps.jsonl` and `vars.jsonl` files produced by the runtime — **filter each file to only keep lines belonging to this test** (by `fn` field on steps, by matching stepIds for vars)
3. Generate `index.json` — see below
4. Enforce eviction: if more than 5 trace folders exist across all files, delete oldest by `mtime` of `steps.jsonl`; if total timeline dir size > 50 MB AND more than 1 test file stored, evict oldest until under limit

**Index generation:**
- Read `steps.jsonl` for this test; record byte offset every 200 steps (step index)
- Read `vars.jsonl` for this test; for each variable key, record byte offset of every root snapshot (`p:[]`) entry (var checkpoints)
- Write `index.json`

**`load(filePath, testName): { stepsPath, varsPath, indexPath } | null`**  
Returns file paths if they exist, null otherwise.

**Logging:** prefix all log lines with `[LTR-STORAGE]`. Log every `exists()` miss/hit, every `save()` start/complete, every eviction, every error with full stack.

---

#### T1.4 — Update `JestInstrumentedRunner.ts`

**File:** `packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts`

Changes:
- Remove `--testNamePattern` arg — run the full file
- Change env vars set before spawn: set `TRACE_STEPS_FILE` and `TRACE_VARS_FILE` (two separate files) instead of `TRACE_OUTPUT_FILE`
- After Jest exits, call `TimelineStorageManager.save(filePath, stepsFile, varsFile, testNamesFromFile)`  
  — `testNamesFromFile` can be read from the steps file (collect unique `fn` values from step lines)
- Return `void` instead of `TimelineStore` — the storage manager is now the consumer
- Keep all existing error logging; prefix timeline-specific logs with `[LTR-RUNNER]`

---

#### T1.5 — Update `TimelineEvent.ts` and `TimelineStore.ts`

**`TimelineEvent.ts`:** Replace `VAR` event shape to match new runtime output:
```ts
| { type: 'VAR'; s: number; n: string; op: 'set'|'del'; p: string[]; v?: any }
```
Also add short-key `STEP` shape to match `{"s","l","f","fn"}` format.

**`TimelineStore.ts`:** Remove `variables: Map<number, VariableSnapshot[]>` — variable state is now reconstructed on demand from `vars.jsonl`, not stored in memory at parse time. The store for in-memory playback state will be added in M2. For now, keep only `steps`, `logs`, `errors`.

---

#### ✅ M1 Milestone Verification

1. Open VS Code extension dev host (`F5`)
2. Open a project with Jest tests
3. Start a Live Test Runner session
4. Click `⏱ Timeline` CodeLens on any test
5. Click **Collect Timeline** in the panel
6. Open **Raw output** panel and confirm you see:
   - `[LTR-RUNNER]` lines showing Jest spawned and exited
   - `[LTR-STORAGE]` lines showing save completed
   - No `[LTR-RUNTIME] write error` lines
7. In your system temp dir, find the `timeline/<file-slug>/<test-slug>/` folder and confirm:
   - `steps.jsonl` exists and has lines like `{"s":1,"l":5,"f":"...","fn":"..."}`
   - `vars.jsonl` exists and has lines like `{"s":3,"n":"car@8","op":"set","p":[],"v":{...}}`
   - `index.json` exists and has `steps` and `vars` checkpoint arrays

---

### M2 — Playback Engine Works

**Goal:** Stepping through the timeline reconstructs correct variable state at each step. The sidebar State panel shows the right variable values. Editor line highlight moves correctly.

---

#### T2.1 — PlaybackEngine class

**File:** `packages/vscode-extension/src/timeline/PlaybackEngine.ts` (new)

```ts
class PlaybackEngine {
  constructor(stepsPath: string, varsPath: string, indexPath: string)
  
  // Load index.json and steps.jsonl headers into memory (called once on open)
  async load(): Promise<{ totalSteps: number; testName: string }>

  // Return reconstructed variable state at step N
  // Uses: cache → nearest checkpoint in index → read+apply patches forward
  async stateAtStep(stepId: number): Promise<VariableState>

  // Return step metadata (line, file) for step N
  stepInfo(stepId: number): { line: number; file: string }
  
  dispose(): void
}
```

`VariableState` = `Map<string, ReconstructedValue>` where key is `name@declLine`.

**Reconstruction algorithm** (per the plan):
1. Check memory cache — return immediately if hit
2. Binary search `index.vars[varKey]` to find nearest checkpoint `stepId ≤ N`
3. `fs.open` the vars file, seek to checkpoint byte offset
4. Read lines from that offset; apply patches forward until `s > N`
5. Store result in cache
6. Return

**Logging:** prefix `[LTR-PLAYBACK]`. Log cache hits at debug level, reconstruction work at info level, errors with full stack.

---

#### T2.2 — Re-wire `TimelineDecorationManager.ts`

Update `applyStep()` to accept `Map<string, ReconstructedValue>` (from `PlaybackEngine`) instead of the old `SerialisedStore.variables[stepId]` lookup.

Update `_formatValue()` to handle the new deep value shape (objects with `__class`, nested objects/arrays up to 6 levels).

---

#### T2.3 — Wire playback step events to sidebar

When the user steps in the panel, the extension host:
1. Calls `PlaybackEngine.stateAtStep(stepId)`
2. Sends `{ type: 'step-update', variables: [...] }` to `ExplorerView` (sidebar)
3. Calls `TimelineDecorationManager.applyStep(filePath, line, variables, stepId)`

---

#### ✅ M2 Milestone Verification

1. Collect timeline for a test that declares at least one variable (e.g. `const car = new Vehicle()`)
2. Use the playback controls (next step, previous step)
3. Confirm in the **Timeline sidebar** (Primary sidebar):
   - State panel shows `car@<line>` with correct value
   - Value updates when you step forward
   - Value is still correct when you step backward
4. Confirm in the editor:
   - The current step line is highlighted
   - Ghost text at the end of the line shows the variable value
5. Confirm in **Raw output**:
   - `[LTR-PLAYBACK]` cache hit/miss lines visible
   - No errors

---

### M3 — Panel UI Complete

**Goal:** The panel looks and works per the spec. Test picker, scope tabs, step bar, playback controls, Collect/Recollect button all work correctly.

---

#### T3.1 — Panel webview UI

Update the timeline panel webview HTML/JS. Components to implement:

**Test picker dropdown** (top of panel):
- Populated from the tests found in `steps.jsonl` for the current file
- Selecting a test calls `TimelineStorageManager.load(filePath, newTestName)` and loads that test's playback engine
- If selected test has no data → show empty state with Collect button

**Scope tabs** (`Test` | `Suite`):
- `Test`: only steps where `fn === selectedTestName`
- `Suite`: steps where `fn` is the selected test OR any `beforeEach`/`afterEach` in the same describe block
- Switching is instant — no re-collection

**Step bar:**
- Shows `step N / total` and a progress bar
- Draggable scrub handle → jump to step

**Playback controls:**
- `|◀` first, `◀` prev, `▶/⏸` play/pause, `▶` next, `▶|` last
- Play auto-advances every 300ms

**Collect / Recollect button:**
- `Collect Timeline` (large, centered) in empty state
- `Recollect` (small, top-right of panel header) when data exists

**Console / Errors section:**
- Shows `log` entries and `error` entries for the **current step only**
- Log lines prefixed with level: `log`, `info`, `warn`, `error`
- Error lines prefixed with `✗`

---

#### ✅ M3 Milestone Verification

1. Open timeline panel for a test file with multiple tests
2. Confirm the **test picker dropdown** lists all tests in the file
3. Switch to a different test — confirm the step bar resets and shows that test's steps
4. Click **Collect Timeline** → confirm button changes to **Recollect** after data loads
5. Use the step bar scrub to jump to step 50 — confirm the editor highlights line 50's step
6. Switch **Test** → **Suite** scope — confirm step count changes (more steps visible in Suite)
7. Check that `console.log` output at a step shows in the **Console** section

---

### M4 — Sidebar UI Complete

**Goal:** The State panel in the sidebar shows variable values as a tree. The Watch panel lets users pin variables.

---

#### T4.1 — Sidebar State panel (variable tree)

Update the timeline sidebar webview HTML/JS.

**State panel:**
- Renders each variable as a tree row: `name@declLine  value`
- If two variables have same `name` (different `declLine`), second shows a `line N` badge
- Objects expanded inline: `car@8  Vehicle { engine: "V8", speed: 60 }`
- Click to expand/collapse nested objects
- Updates on every step change (receives `step-update` message from extension host)

**Watch panel:**
- User types a variable name (or clicks "Add to Watch" in hover popup)
- Pinned variables show their current value at each step
- Persists across step changes; cleared when a new test is loaded

---

#### ✅ M4 Milestone Verification

1. Step through a test where a variable changes value (e.g. `speed` goes from `0` to `60`)
2. Confirm State panel shows the correct value at each step
3. Hover on a variable in the editor → click **Add to Watch**
4. Confirm the variable appears in the Watch panel and updates as you step
5. Confirm class instances show `Vehicle {}` not just `{}`
6. Confirm objects can be expanded/collapsed in the State panel

---

### M5 — Cleanup & Polish

#### T5.1 — Remove auto-trace / session-start trace

Search for any code that starts tracing at session start or file open. Remove it. The only trigger for trace collection must be the "Collect Timeline" button.

#### T5.2 — CodeLens wiring

Confirm `⏱ Timeline` CodeLens calls `liveTestRunner.openTimelineDebugger(filePath, testFullName)` and that this correctly:
1. Opens the panel (routes to timeline view)
2. Opens the sidebar (routes to timeline sidebar)
3. Checks `TimelineStorageManager.exists()` → loads immediately or shows empty state

#### T5.3 — Exit timeline mode

When the user closes the timeline panel or switches away:
- `TimelineDecorationManager.clearAll()`
- `ExplorerView` routes back to normal explorer
- `ResultsView` routes back to normal results

#### T5.4 — Edge cases

- Test file with zero tests → empty state, Collect button disabled
- Jest run fails during collection → show error state in panel with message from stderr
- `vars.jsonl` missing but `steps.jsonl` exists → load steps only, show empty State panel with a warning

---

#### ✅ M5 Milestone Verification

1. Start a session, open timeline for a test, close the timeline panel
2. Confirm the editor line highlight disappears
3. Confirm the sidebar returns to the normal test explorer
4. Confirm no `[LTR-TIMELINE]` errors appear in Raw output during normal (non-timeline) test runs
5. Confirm opening timeline for a different test after closing the first works correctly

---

## Logging Reference

All log lines must be parseable from the **Raw output** channel. Format:

```
[LTR-<COMPONENT>] <level> <message>
```

| Component tag | Where it logs | Examples |
|---|---|---|
| `[LTR-RUNTIME]` | `process.stderr` from Jest child process | write error, patch written |
| `[LTR-TRANSFORM]` | `process.stderr` from Jest child process | file being transformed, chain errors |
| `[LTR-RUNNER]` | extension Output channel | jest spawned, jest exited, env vars set |
| `[LTR-STORAGE]` | extension Output channel | exists hit/miss, save start/complete, eviction |
| `[LTR-PLAYBACK]` | extension Output channel | cache hit/miss, reconstruction step count |
| `[LTR-TIMELINE]` | extension Output channel | panel opened, collect requested, step changed |

**On any error:** always log the full message and stack. User only needs to copy-paste the Raw output to report a bug.

---

## Decisions Locked

| # | Decision |
|---|----------|
| 1 | Panel opens empty, waits for "Collect Timeline" — no auto-run |
| 2 | Collect runs the full file — all tests in the file get data in one pass |
| 3 | Button: "Collect Timeline" when no data, "Recollect" when data exists. No per-test indicators in dropdown |
| 4 | Scope: Test and Suite only. File scope removed — incoherent timeline, not useful |
| 5 | Scope is a display filter only — switching is instant, no re-collection needed |
| 6 | Panel contains: test picker, scope tabs, Recollect button, step bar, playback controls, console/errors |
| 7 | Sidebar contains: State (variable values at current step), Watch (pinned variables) |
| 8 | No variables pane in the panel — sidebar owns variable state, no duplication |
| 9 | No Call Stack panel — single `functionName` per step is not enough; add in future if entry/exit tracking is added |
| 10 | Three files per test: `steps.jsonl`, `vars.jsonl`, `index.json` |
| 11 | Variables keyed as `name@declarationLine` — unique across scopes |
| 12 | Same-name variable collision → `line N` badge on second variable in State panel |
| 13 | Delta-patch variable capture — write only changed paths, not whole object |
| 14 | Checkpoint every 100 patches → new root snapshot; caps reconstruction at 100 patches max |
| 15 | Reconstruction always forward from nearest checkpoint — no reverse patching, no `prev` storage |
| 16 | Byte-offset index (`index.json`) — fast seek to any checkpoint without scanning |
| 17 | Step cache in memory during playback — revisited steps are instant |
| 18 | Arrays always re-snapshotted in full when changed — no array diffing |
| 19 | Capture bounds: 6 levels deep, strings 500 chars, arrays 100 items |
| 20 | Storage limits: 5 traces AND 50 MB (50 MB only when >1 test file stored) |
| 21 | Timeline data is session-scoped — auto-cleaned with session temp dir |
| 22 | All prior code referenced for implementation; decisions in this document take full priority |
