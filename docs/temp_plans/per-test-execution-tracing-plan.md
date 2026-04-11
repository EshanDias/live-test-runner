# Per-Test Execution Tracing — Design Plan

> Captures all design decisions from the initial discussion.
> Update this file as decisions evolve. Do not create a new one.

---

## 1. What This Is

A system that instruments every test run to produce a detailed execution trace per test case. The trace records every line executed, in every file, in order — with variable values at each step. This data drives:

- **Per-test console output** scoped correctly in the Test Results panel (solves Jest's file-level-only output problem)
- **Line-level gutter decorations** in source files showing which lines ran for a selected test
- **Coverage map** per test case and accumulated per session
- **Timeline Debugger** (already built — this system feeds it with richer data)
- **Future: branch coverage** (data will be there, feature deferred)

---

## 2. Core Data Structures

### 2.1 Step (the atomic unit)

Every instrumented statement produces one step object:

```ts
interface Step {
  line: number
  file: string           // absolute path, node_modules excluded
  className?: string     // best-effort, undefined for plain functions
  method?: string        // best-effort, undefined for anonymous functions
  vars: Record<string, unknown>  // variable name → value snapshot at this line
  context: 'beforeAll' | 'beforeEach' | 'test' | 'afterEach' | 'afterAll'
  testName?: string      // populated when context === 'test'
}
```

### 2.2 Trace file (per test case, written to disk)

One JSONL file per test case. Path stored in the main store.

```
/tmp/ltr-traces/<sessionId>/<testId>.jsonl

Content: Step[]   // ordered array, can be thousands of entries
```

Large tests produce large files — that is expected and acceptable.

### 2.3 Main store reference (in memory)

```ts
Map<testId, string>   // testId → absolute path to trace file
```

`testId` = full test name: `"describe title > nested describe > test name"` — same key Jest uses for `--testNamePattern`. No custom ID needed. Rename = delete old entry + add new one (same pattern as the existing FileSystemWatcher).

### 2.4 Coverage index (in memory, accumulated per session)

```ts
Map<filePath, Set<number>>
```

Built by accumulating all steps across all tests. Every line number that any test executed gets added to the set. Never resets mid-session — only on session restart.

Used for: gutter decorations on source files showing "this line ran during this session."

### 2.5 Source file → test mapping

```ts
Map<sourceFilePath, {
  [testFilePath: string]: {
    [suiteName: string]: {
      isSharedVars: boolean
      sharedVarNames: string[]   // variable names detected as shared (for display)
      testCases: string[]        // test names in this suite (full names)
    }
  }
}>
```

Used for: when a source file is saved, look up which suites are affected and decide run scope (whole suite vs individual test).

---

## 3. Shared Variable Detection (`isSharedVars`)

Populated **statically at discovery time** using AST — no code execution needed. Runs as part of the existing `testDiscovery.js` AST walker pass.

### Detection rules

A suite is marked `isSharedVars: true` if any variable declared **at the `describe` scope** (not inside any `it`/`test` block) is referenced inside any `it`/`test` block.

Same logic applies one level up: file-scope `let`/`var` referenced in any `it` → every suite in that file is `isSharedVars: true`.

### `const` handling

| Initializer type | Mutable? | Flag as shared? |
|---|---|---|
| `let x` / `var x` | yes | always |
| `const x = 0` (primitive literal) | no | no |
| `const obj = {}` / `const arr = []` / `const x = new Foo()` / `const x = fn()` | yes (mutation) | yes |

Primitives: `NumericLiteral`, `StringLiteral`, `BooleanLiteral`, `NullLiteral` — safe.
Everything else: treat as mutable.

### Why AST is better than let/const/var alone

AST can see whether the variable is actually **referenced across test boundaries**, not just declared. A `let` that's only used inside one `it` is not shared. The reference graph is what matters, and AST gives us that.

---

## 4. Instrumentation Scope

- **All files loaded during a test run** — follows imports/requires recursively from the test file
- **Excludes `node_modules`** — we only trace code we wrote
- **Includes**: test file itself, all source files it imports, transitively
- **Step context tag** — every step is tagged with whether it's executing inside a hook or the test body

---

## 5. Initial Run Behaviour

On **Start Testing** (full session warm-up run):

1. Instrument all test files (and their source imports) with the trace transform
2. Run all test files (existing concurrency: up to 3 in parallel)
3. As each file completes:
   - Partition the flat step array into per-test slices (using context tags + test name)
   - Each slice includes: all `beforeAll` steps for wrapping suites + `beforeEach` + test body + `afterEach` + `afterAll`
   - Write each slice to `/tmp/ltr-traces/<sessionId>/<testId>.json`
   - Update the main store: `testId → filePath`
   - Accumulate all steps into the coverage index (`Map<filePath, Set<number>>`)
4. `isSharedVars` detection runs at discovery time (before this), so it is already available

---

## 6. Run Unit

### Run scope decision

| Trigger | `isSharedVars` | Run scope | Trace files updated |
|---|---|---|---|
| Start Testing (initial) | any | Whole file | All tests in the file |
| Test file saved | any | Whole file | All tests in the file |
| Source file saved | any | All affected test files (existing coverage map lookup) | All tests in those files |
| Individual test rerun | `false` | Just that test case (with its hooks: beforeAll/beforeEach/afterEach/afterAll) | Only that test's trace file |
| Individual test rerun | `true` | Whole suite | All test trace files in that suite |

**No shared vars:** run only the target test. Jest executes its wrapping hooks naturally. Rewrite only that test's trace file — other tests in the suite are untouched.

**Shared vars:** run the whole suite so shared state is real and correct. Rewrite every test's trace file in that suite.

---

## 7. Source File Change → Affected Test Resolution

When a source file is saved:

1. Look up `sourceFilePath` in the source→test mapping (Section 2.5)
2. For each affected suite:
   - If `isSharedVars: true` → run the whole suite
   - If `isSharedVars: false` → can run individual affected test cases
3. After the run: replace trace files for the tests that ran, update coverage index for those files

The source→test mapping is built during the initial instrumented run (we know which source files each test file imports because we traced the execution). It is updated incrementally on each subsequent run.

---

## 8. Console Output Per Test

Jest reports console output at file level only — there is no per-test output in Jest's JSON. The existing `ScopedOutput` system in `ResultStore` (file → suite → test, with `lines: OutputLine[]`) is the right structure and stays as-is.

The trace provides the missing piece: because every step is tagged with `testName` and `context`, we know exactly which test was executing when each `console.log` fired. The instrumentation captures console calls and routes them into the correct `ScopedOutput` scope (file / suite / test) in `ResultStore`.

No redesign of `ScopedOutput` — the existing shape already models what we need. We just populate test-level output correctly instead of leaving it empty.

---

## 9. Gutter Decorations (Source Files)

Using the coverage index (`Map<filePath, Set<number>>`):

- When a source file is opened in the editor, check the coverage index
- Lines present in the set get a "ran" gutter decoration
- When the user selects a specific test in the Results panel, switch to showing only that test's trace lines (load the trace file, extract unique line numbers for this source file) this feature comes with the time line selection only. not now. also this comes from traces not this map.

Two decoration modes:
- **Session mode**: all lines that ran across any test (from coverage index, in memory — fast)
- **Test-selected mode**: only lines that ran for the selected test (from trace file on disk — loaded on demand) (Future task)

---

## 10. Branch Coverage (Deferred)

The step data contains enough information to compute branch coverage in future:

- Every `if`/`else`, `switch`, ternary, `&&`/`||` branch point can be instrumented with a branch ID
- Each step can include `{ branchId, taken: true | false }`
- Coverage index can be extended to `Map<filePath, { lines: Set<number>, branches: Map<branchId, boolean[]> }>`

**Not in scope now.** The trace format should leave room for it (the `vars` field on Step can carry branch info when the time comes, or Step gets a dedicated `branch` field).

---

## 11. What Stays Unchanged

Everything in the existing architecture is untouched:

| Component | Change |
|---|---|
| `ResultStore` | No change |
| `SessionManager` | No change |
| `JestRunner` / `JestAdapter` | No change |
| `TestDiscoveryService` | Extended: also detects `isSharedVars` per suite |
| `testDiscovery.js` | Extended: shared var detection added to the AST walker |
| `TimelineStore` | No change — Timeline Debugger continues to work as-is |
| `traceTransform.js` | Extended: now instruments all source files, not just the target file |
| `traceRuntime.js` | Extended: writes steps with context tags and testName |

---

## 12. Open Questions

- [x] **Trace file format**: JSONL — one step per line. Streamable, no need to load the full file into memory to slice or search. Extension is `.jsonl`.
- [x] **Trace file cleanup**: Triggered by the VS Code command (not the button click directly — covers keyboard shortcuts too). Two events:
  1. `liveTestRunner.startTesting` command fires → delete `/tmp/ltr-traces/<sessionId>/` if it exists, then start the new session
  2. Workspace/folder/window close → VS Code `deactivate()` hook deletes the traces directory
- [ ] **Memory pressure**: The coverage index is in memory. For very large projects (500+ source files, thousands of unique lines), is a `Map<string, Set<number>>` acceptable? Likely yes — each Set entry is just a number.
- [ ] **Branch coverage instrumentation**: Defer until line coverage is stable and useful.
