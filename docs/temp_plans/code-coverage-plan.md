# Code Coverage Plan

> **Source of truth for all code coverage decisions.**
> Every design change must be recorded here before or immediately after it is made.
> Last updated: 2026-04-12

---

## Glossary

| Term | Meaning |
|---|---|
| **coverage manifest** | Per-file JSON written by `sessionTraceTransform.js` when Jest loads a file during a trace run. Contains every statement/branch/function with IDs and line locations. Stored on disk in temp dir (required because transform runs in a separate Jest child process — disk is the bridge). |
| **`__cov` counters** | Integer counters injected by `sessionTraceTransform.js`. Increment at runtime. Give the COVERED count (numerator). Always in sync with the manifest — same AST pass, same IDs. |
| **`sessionTraceTransform.js`** | Existing Jest transform hook for session trace runs. Extended to inject `__cov` counters AND write the coverage manifest. Runs at test-run time per file, inside the Jest child process. Do NOT confuse with `traceTransform.js` which belongs to the Timeline Debugger and must not be touched. |
| **`sessionTraceRuntime.js`** | The `__strace` global inside the Jest child process. Extended to JSONL-append `globalThis.__cov` to `COVERAGE_OUTPUT_FILE` on process exit. Do NOT confuse with `traceRuntime.js` (Timeline Debugger). |
| **`SourceCounter.ts`** | Lightweight background class. Runs at session start (like test discovery, in parallel with everything else). AST-parses every source file and counts statements/branches/functions. In-memory only — no disk writes. Provides the denominator for files that tests never touch. |
| **`CoverageStore`** | New in-memory store (separate from `ExecutionTraceStore`). Single map the UI reads. Starts populated by `SourceCounter`, entries promoted to full detail as test runs complete. |
| **`'counted'` entry** | A `CoverageStore` entry in its initial state — totals from `SourceCounter`, 0 hits. All files start here. |
| **`'measured'` entry** | A `CoverageStore` entry after a test run touches the file — full manifest + real counters. Replaces the `'counted'` entry in-place. |
| **`'measured-stale'` entry** | A `'measured'` entry whose file has been saved but whose re-run has not yet completed. Gutter shown greyed out until promoted back to `'measured'`. |
| **touched file** | A source file that Jest loaded during the test run. Entry promoted to `'measured'`. |
| **untouched file** | A source file no test imports. Stays `'counted'` forever — correctly shows as 0% covered. |

---

## 1. What we already have

| Capability | Where it lives | Notes |
|---|---|---|
| Executed line numbers per source file | `ExecutionTraceStore._coverageIndex` | Accumulated across all tests, never reset mid-session |
| Test → JSONL trace file mapping | `ExecutionTraceStore._traceIndex` | One JSONL per test case |
| Source file → test file → suite mapping | `ExecutionTraceStore._sourceToTests` | Used for smart re-run scoping |
| `@babel/parser` + traverse + generator | `sessionTraceTransform.js` (already in use) | No new dependency needed |

---

## 2. The untouched-file problem

**Problem (identified 2026-04-12):** If a source file is never imported by any test, Jest never loads it, so `sessionTraceTransform.js` never runs on it. A purely lazy approach makes that file invisible to coverage — but it should count as 0% covered.

```
Project: 10 source files
Tests import: 7 of them
3 files never loaded

Lazy-only result:  85% coverage  (denominator = statements in 7 files)  ← WRONG
Correct result:    60% coverage  (denominator = statements in all 10)   ← RIGHT
```

**Solution: `SourceCounter.ts` runs in the background at session start.** It counts statements/branches/functions for every source file via AST. Counts are held in memory. No disk writes. Never blocks test runs. Untouched files get their counts from here with 0 hits — correct 0% coverage.

Istanbul/nyc solves this exact problem with a config flag called `all: true`. We solve it the same way, automatically.

---

## 3. Architecture — two parallel tracks (same pattern as test discovery)

**The analogy:**
- Test discovery: scan all test files at start → build pending test map → results fill it in as runs complete
- Coverage: scan all source files at start → build `CoverageStore` with 0-hit entries → test runs promote entries to real data

```
User clicks Start Testing
        │
        ├──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼                                                          ▼
SourceCounter.ts starts                                   Test run starts
(background, like discovery)                              (existing behaviour)
        │                                                          │
  AST-parse every source file                  sessionTraceTransform.js runs
  count stmt/branch/fn per file                per file Jest loads:
  populate CoverageStore                         → injects __cov counters
  all entries = 'counted', 0 hits                → writes manifest to coverageDir/manifests/
  no disk writes                                 → injects __strace.step()
        │                                                          │
        │                                              Jest child process exits
        │                                                → sessionTraceRuntime JSONL-appends
        │                                                  __cov to COVERAGE_OUTPUT_FILE
        │                                                          │
        └──────────────────┬───────────────────────────────────────┘
                           ▼
              SessionTraceRunner reads manifest + __liveCov
              For each touched file:
                → read manifest from temp dir
                → read counters from __liveCov
                → update CoverageStore entry: 'counted' → 'measured'
              Untouched files stay 'counted', 0 hits
                           │
              CoverageReport recalculates totals
              Coverage badge + gutter decorations update
```

**If test run finishes before SourceCounter:**
Badge continues to show `"Scanning source files… N / M"`. Coverage totals are NOT displayed until SourceCounter finishes — because the denominator is incomplete (untouched files not yet counted). This avoids showing an inflated percentage. Once SourceCounter emits `'done'`, totals are calculated across all entries and the badge renders.

**If SourceCounter finishes before test run:**
`CoverageStore` is ready with all 0-hit entries. No visible UI change yet. Spinner stays until test run completes.

**Test results and coverage are always independent.** Test results update per-file as each finishes (unchanged). Coverage badge updates once after the full run.

---

## 4. CoverageStore — the live map

New in-memory store. The UI always reads from here.

```typescript
// Entry shapes
type CoverageEntry =
  | { state: 'counted';        statements: number; branches: number; functions: number; lines: number }
  | { state: 'measured';       manifest: Manifest; counters: LiveCov; pct: CoveragePct }
  | { state: 'measured-stale'; manifest: Manifest; counters: LiveCov; pct: CoveragePct }

// The store
CoverageStore
  entries: Map<filePath, CoverageEntry>

  // Totals — recalculated whenever any entry updates
  totals: {
    statements: { covered: number, total: number, pct: number }
    branches:   { covered: number, total: number, pct: number }
    functions:  { covered: number, total: number, pct: number }
    lines:      { covered: number, total: number, pct: number }
  }
```

**Totals always use all entries:**
```
total statements = Σ all entries
  'counted'        → entry.statements         (from SourceCounter)
  'measured'       → manifest statement count  (from transform)

covered statements = Σ measured entries only
  'counted'        → 0  (never touched by tests)
  'measured'       → count of s[id] > 0

pct = covered / total  ←  always includes untouched files, always correct
```

---

## 5. Coverage manifest — shape (written by traceTransform, touched files only)

```
<LTR_TMP_DIR>/coverage-<sessionId>/manifests/<hash-of-file-path>.json
```
(`LTR_TMP_DIR` is the extension's shared temp dir defined in `constants.ts`. `sessionId = Date.now()` set in `extension.ts`.)

```json
{
  "filePath": "/abs/path/to/source.ts",
  "statements": {
    "s0": { "start": { "line": 5, "col": 2 }, "end": { "line": 5, "col": 20 } }
  },
  "branches": {
    "b0": { "type": "if", "line": 8, "arms": 2 },
    "b1": { "type": "ternary", "line": 14, "arms": 2 }
  },
  "functions": {
    "f0": { "name": "handleSave", "start": { "line": 4 }, "end": { "line": 12 } }
  }
}
```

Overwritten on every run (same path, deterministic hash). IDs always match counters — same AST pass.

---

## 6. Branch coverage — how it works

The runtime alone cannot show uncovered branches. The manifest provides the full picture:

```
Manifest: b0 is an if/else on line 8, 2 arms
Counters: b0 = [1, 0]  →  arm 0 ran, arm 1 never ran  →  50% branch coverage

Manifest: b1 is a ternary on line 14, 2 arms
Counters: b1 = [0, 0]  →  neither arm ran  →  0% (dead code path)
```

What the transform injects for a branch:
```js
// Original
if (user.isAdmin) { doAdmin(); }

// After transform
if (user.isAdmin) {
  __cov.b["b0"][0]++;     // true arm
  doAdmin();
} else {
  __cov.b["b0"][1]++;     // false arm (synthetic else — added even if original has none)
}
```

---

## 7. Coverage metrics

| Metric | Touched files | Untouched files |
|---|---|---|
| **Statement** | `s[id] > 0` vs manifest total | 0 / SourceCounter count |
| **Branch** | `b[id][arm] > 0` vs manifest total arms | 0 / SourceCounter count |
| **Function** | `f[id] > 0` vs manifest total | 0 / SourceCounter count |
| **Line** | lines with ≥1 executed stmt vs manifest lines | 0 / SourceCounter line count |

---

## 8. UI decisions

### 8.1 Coverage lifecycle states

| State | Coverage section shows |
|---|---|
| Session not started | Hidden |
| Session started, first run not complete | Spinner: `"Scanning source files… 14 / 40"` (SourceCounter progress) |
| SourceCounter done, tests still running | Spinner: `"Updating coverage…"` |
| Both done | Badge: `Stmts 87% \| Branches 72% \| Fns 91% \| Lines 89%` |
| File saved, re-run in progress | Old badge stays + spinner overlay until updated |

Test results panel is always independent — never shows a coverage spinner.

### 8.2 Gutter decorations
- Executed lines: green gutter (heatmap intensity — darker = higher hit count, designed in T1).
- Unexecuted lines: opt-in only (default off).
- Stale (file saved, re-run not complete): grey gutter for the **entire file** until the rerun completes. v1 = whole-file stale. Function-level stale range is a v2 feature (§20).

### 8.3 Sole-coverage warnings — **DEFERRED to v2**
Requires per-branch → [test names] mapping not tracked in v1 CoverageStore. Gutter decoration type will be created as a stub but no lines decorated. See §25.7.

### 8.4 Explorer badge
```
Stmts: 87%  |  Branches: 72%  |  Fns: 91%  |  Lines: 89%
```
Per-file breakdown is a later iteration.

### 8.5 Coverage trend — LOW PRIORITY
Persist to `.vscode/live-test-runner-coverage.json`. Show delta on next session. Deferred.

---

## 9. Diff checker — **DEFERRED to v2**

> Full design moved to §20. For v1, the entire file is marked `'measured-stale'` on save. Function-level stale marking requires per-function test coverage mapping not built in v1.

### Purpose (v2)
When a file is saved: detect which functions genuinely changed (logic, not formatting) so we can mark only those function ranges stale.

### Approach — function-level AST diff, formatter-safe

```
Before save:  parse file from disk → FunctionBoundary[]
After save:   parse new content    → FunctionBoundary[]

Diff:
  same key + same bodyHash  → not changed (formatting only, no logic change)
  same key + diff bodyHash  → genuinely changed
  key in before, not after  → function deleted
  key in after, not before  → function added
```

**`FunctionBoundary` shape:**
```typescript
{
  key: string       // scoped name — "functionName" | "ClassName.method" | "fnName@line"
                    // line used as tiebreaker for anonymous or duplicate-name functions
  startLine: number // used only for stale marking range — NOT part of diff comparison
  endLine: number
  bodyHash: string  // SHA-256 of AST body with loc/position data stripped and
                    // whitespace normalised — formatter-safe
}
```

**Why formatter-safe:** A formatter (Prettier, ESLint fix) changes whitespace and line positions but not AST structure. `bodyHash` is derived from the AST nodes only (position fields stripped before hashing). A reformat produces the same hash as before → zero false positives.

**Stale marking:** When a function is flagged as changed, its `startLine`–`endLine` range in `CoverageStore` is marked `'measured-stale'`. The full function boundary goes stale — not just the changed lines. This is correct: "this function's logic changed, treat all its coverage as suspect until re-run."

**Line-level stale marking is not needed** — the stale state is temporary (tests run fast). More granular stale marking (individual lines) is only relevant for a future live-as-you-type debugger, not a save-triggered flow.

**Integration:** `SessionManager.onDidSaveTextDocument()` → diff → `changedFunctions[]` → cross-reference `CoverageStore` + `sourceToTests` → run only impacted tests → mark function ranges stale.

---

## 10. Formatting does not affect coverage statistics

Coverage counts **executable constructs** (statements, branch arms, functions, executable lines) — not raw line numbers. A formatter changes *where* constructs sit in the file but never *how many* there are. Stats are unaffected.

- Blank lines are never executable — adding/removing them changes nothing.
- A multi-line statement (Prettier wraps a long call across 3 lines) is still one statement.
- After a reformat triggers a save → re-run, the manifest is rewritten with updated line numbers. Gutter decorations stay correct automatically.
- The `bodyHash` in the diff checker strips position data before hashing — a reformat produces the same hash as before, zero false positives.

---

## 11. All decisions — closed

| # | Question | Decision |
|---|---|---|
| 1 | Unexecuted line gutter decoration by default? | Opt-in only — show executed lines only by default |
| 2 | Sole-coverage warnings? | Deferred to v2 — requires per-branch→test mapping not in v1 |
| 3 | Stale marking granularity? | v1 = whole file on save. Function-level stale (DiffChecker) deferred to v2 |
| 4 | Coverage trend | Deferred (§8.5) |
| 5 | Per-test breakdown in v1? | Aggregate first, per-test later |
| 6 | Coverage on every save or on demand? | Every save, with loading spinner |
| 7 | Separate upfront scan for all files? | Yes — `SourceCounter.ts`, background, in-memory, no disk writes |
| 8 | Formatter safety | bodyHash (v2 DiffChecker) strips position data — zero false positives |
| 9 | Coverage enable/disable toggle? | No — always on, non-blocking, no perf impact |
| 10 | Counter write race (multi-worker)? | JSONL appendFileSync per worker pid, merged by SessionTraceRunner |
| 11 | Partial rerun coverage merge? | max() per counter ID — preserves coverage from untouched tests |
| 12 | 'counted' files display | Show 0% (not —) — consistent with metric toggle |
| 13 | Source file discovery | `vscode.workspace.findFiles` + user-configurable exclude list (§26) |

---

## 11b. Implementation order (v1 only)

1. **`CoverageStore.ts`** + **`src/coverage/types.ts`** — in-memory store + all shared types (Manifest, LiveCov, CoveragePct, CoverageEntry).
2. **`SourceCounter.ts`** — background scan at session start. Uses `vscode.workspace.findFiles`. Populates `CoverageStore` with `'counted'` entries.
3. **Extend `sessionTraceTransform.js`** — inject `__cov` counters + write manifest in the same AST walk.
4. **Extend `sessionTraceRuntime.js`** — JSONL-append coverage counters on `process.on('exit')`.
5. **`CoverageReport.ts`** — stateless metric calculation.
6. **Extend `SessionTraceRunner`** — set env vars, read + merge JSONL counters, promote `CoverageStore` entries.
7. **Wire into `SessionManager`** — SourceCounter on start, whole-file `markFileStale` on save, `CoverageStore.clear()` on stop.
8. **`IResultObserver.ts`** — add `onSourceScanProgress`, `onSourceScanDone`, `onCoverageUpdated`.
9. **`CoverageDecorationManager.ts`** — gutter decorations (green heatmap, grey stale, sole-coverage stub).
10. **Explorer view** — coverage summary row in main view (spinner states + 4-column badge).
11. **Coverage Explorer view** — new router view `coverageExplorerView.js` with file tree.
12. **`package.json`** — settings: `showUncoveredLines`, `coverageExclude`, `coverageThresholds`.
13. **Docs update** — §33.

---

## 12. Naming warning — two transforms, two runtimes

The codebase has **two separate pairs** of transform + runtime files. They must never be confused:

| File | Belongs to | Coverage work? |
|---|---|---|
| `src/session/instrumentation/sessionTraceTransform.js` | Session trace runner | ✅ Extend this |
| `src/session/instrumentation/sessionTraceRuntime.js` | Session trace runner | ✅ Extend this |
| `src/timeline/instrumentation/traceTransform.js` | Timeline Debugger | ❌ Do not touch |
| `src/timeline/instrumentation/traceRuntime.js` | Timeline Debugger | ❌ Do not touch |

All coverage work (`__cov` injection, manifest write, JSONL flush) goes into the **session** variants only.

---

## 13. File structure — new and modified files

```
packages/vscode-extension/src/
│
├── coverage/                              ← new directory
│   ├── CoverageStore.ts                   ← new — in-memory store (§4)
│   ├── SourceCounter.ts                   ← new — background scan at session start (§3 architecture)
│   ├── CoverageReport.ts                  ← new — metric calculation from CoverageStore
│   └── DiffChecker.ts                     ← new — function-level AST diff on save
│
├── session/
│   ├── SessionManager.ts                  ← modified — wire SourceCounter on start, DiffChecker on save
│   ├── SessionTraceRunner.ts              ← modified — set COVERAGE_OUTPUT_FILE, read + promote CoverageStore
│   └── instrumentation/
│       ├── sessionTraceTransform.js       ← modified — inject __cov counters + write manifest
│       └── sessionTraceRuntime.js         ← modified — flush __liveCov to COVERAGE_OUTPUT_FILE on exit
│
├── editor/
│   └── CoverageDecorationManager.ts      ← new — gutter green/grey/sole-coverage decorations
│
└── IResultObserver.ts                     ← modified — add onCoverageUpdated(), onSourceScanProgress()
```

All coverage files live under `vscode-extension` because `CoverageStore` depends on vscode types (URI, event emitters). `CoverageReport.ts` has no vscode dependency and could move to `core` later, but starts here to avoid monorepo build churn.

---

## 14. `SourceCounter.ts` — detailed design

### Trigger
Called from `SessionManager.start()` immediately after `this._session.activate()`, before `_runFiles()`. Mirrors the position of `TestDiscoveryService` — both run at session start in parallel with the test runs.

```typescript
// SessionManager.start() — additions
const coverageStore = this._coverageStore; // injected
const sourceCounter = new SourceCounter(projectRoot, coverageStore);
sourceCounter.on('progress', (scanned, total) => {
  this._notify('onSourceScanProgress', scanned, total);
});
sourceCounter.on('done', () => {
  this._notify('onSourceScanDone');
});
// Fire and forget — runs in parallel with _runFiles
void sourceCounter.run();

await this._runFiles(testFiles, projectRoot, true);
```

### Source file discovery
**No new glob dependency.** Use `vscode.workspace.findFiles` — same approach as `TestDiscoveryService`. This API handles workspace roots, symlinks, and excludes automatically.

```typescript
const include = new vscode.RelativePattern(projectRoot, '**/*.{js,ts,jsx,tsx}');
const defaultExclude = '{**/node_modules/**,**/*.{test,spec}.{js,ts,jsx,tsx},**/*.config.{js,ts,mjs,cjs},**/*.d.ts,dist/**,build/**,out/**,.next/**,coverage/**}';
const userExclude    = vscode.workspace.getConfiguration('liveTestRunner').get<string[]>('coverageExclude', []);
// Merge: default glob + user patterns joined with comma inside {}
const excludeGlob    = userExclude.length
  ? `{${defaultExclude.slice(1, -1)},${userExclude.join(',')}}`
  : defaultExclude;

const uris = await vscode.workspace.findFiles(include, excludeGlob);
```

### Babel parser options for TypeScript
`SourceCounter` must parse TS/TSX with the same Babel plugin set used by `sessionTraceTransform.js`, otherwise it will throw on TS syntax. Use:
```typescript
_parser.parse(source, {
  sourceType: 'module',
  plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy', 'optionalChaining', 'nullishCoalescingOperator'],
  errorRecovery: true,   // don't crash on syntax errors — just count what we can
})
```

`errorRecovery: true` is important: if a file has a syntax error mid-edit, SourceCounter logs a warning and moves on rather than crashing the whole scan.

### AST count logic
Uses `@babel/parser` + `@babel/traverse` (already in node_modules — no new deps).

```typescript
class SourceCounter extends EventEmitter {
  async run(): Promise<void> {
    // Uses vscode.workspace.findFiles — no glob library needed (see §14 source file discovery)
    const uris  = await vscode.workspace.findFiles(include, excludeGlob);
    const total = uris.length;
    let scanned = 0;

    for (const uri of uris) {
      const counts = this._countFile(uri.fsPath);
      this._store.setCountedEntry(uri.fsPath, counts);
      this.emit('progress', ++scanned, total);
    }

    this.emit('done');
  }

  private _countFile(filePath: string): { statements: number; branches: number; functions: number; lines: number } {
    // Parse with @babel/parser, traverse with visitor:
    //   Statement visitor → statements++
    //   IfStatement, ConditionalExpression, LogicalExpression, SwitchStatement → branches += arm count
    //   FunctionDeclaration, ArrowFunctionExpression, FunctionExpression, ClassMethod → functions++
    // Lines = count of unique line numbers that contain executable statements
  }
}
```

Counting runs synchronously per file — no I/O after the initial read. Fast enough to complete before most test suites finish.

---

## 15. Extending `sessionTraceTransform.js` — counter injection

### What changes
The existing transform already does one AST walk per file to inject `__strace.step()` calls. Coverage counter injection happens **in the same walk** — no second pass, no extra Babel traversal.

### New injections per file

**At file top** (after existing `__strace` setup block), inject a counter init:
```js
// injected preamble
if (!globalThis.__cov) { globalThis.__cov = {}; }
globalThis.__cov[__COV_FILE_ID__] = {
  s: { /* "s0": 0, "s1": 0, ... */ },
  b: { /* "b0": [0, 0], ... */ },
  f: { /* "f0": 0, ... */ },
};
const __covF = globalThis.__cov[__COV_FILE_ID__];
```

`__COV_FILE_ID__` = a deterministic hash of the absolute file path (same hash used for the manifest filename, ensuring IDs always match).

**Per statement** (same node the `__strace.step()` call is prepended to):
```js
__covF.s["s0"]++;   // prepended before the statement
```

**Per branch** (wrapping if/else, ternary, logical):
```js
// if/else example
if (cond) {
  __covF.b["b0"][0]++;
  ...body...
} else {
  __covF.b["b0"][1]++;
}
```

**Per function** (at the first line of the body):
```js
function handleSave() {
  __covF.f["f0"]++;
  ...body...
}
```

### Manifest write (transform time)
After the AST walk, write the manifest to disk **from within the transform process** using `LTR_MANIFEST_DIR` env var:
```js
const manifestDir = process.env.LTR_MANIFEST_DIR;  // set by SessionTraceRunner
if (manifestDir) {
  const manifestPath = path.join(manifestDir, `${fileHash}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}
```
Path resolves to:
```
<LTR_TMP_DIR>/coverage-<sessionId>/manifests/<fileHash>.json
```

This is the only disk write from the transform. The manifest is written every time the file is transformed — which on first run is once per file. On re-runs, Jest's transform cache normally skips the transform, so the manifest already exists. When a file changes, Jest invalidates cache → transform re-runs → manifest refreshes automatically.

### Counter reset between files
`globalThis.__cov[__COV_FILE_ID__]` is keyed by file hash. Separate keys per file, no collision. No reset needed — each file's counters only accumulate from that file's code.

---

## 16. Extending `sessionTraceRuntime.js` — coverage flush

### New env var
`COVERAGE_OUTPUT_FILE` — set by `SessionTraceRunner` alongside `SESSION_TRACE_FILE`. Points to a temp file where the runtime writes the accumulated counters.

### Flush on exit — JSONL append (one line per worker)
At the bottom of `sessionTraceRuntime.js`, add:
```js
process.on('exit', () => {
  const covFile = process.env.COVERAGE_OUTPUT_FILE;
  if (!covFile || !globalThis.__cov) { return; }
  try {
    // appendFileSync — multiple workers write to same file without overwriting each other.
    // Each worker appends exactly one line: { workerPid, cov }.
    fs.appendFileSync(
      covFile,
      JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n',
      'utf8'
    );
  } catch (_e) {}
});
```

Each worker appends one line. If a single-worker run, one line. If two workers, two lines. `SessionTraceRunner` reads all lines and merges (§17).

The `process.on('exit')` handler runs synchronously at process teardown — no async risk.

### Why file-hash keys (not file path)
File paths can contain special characters and are long. The hash is the same one used in the manifest filename — lookup is O(1) and the manifest→counter pairing is always exact, even across different OS path separators.

---

## 17. `SessionTraceRunner` extensions

### Env vars and paths

Coverage gets its own session-scoped directory, separate from `traceDir` (which holds JSONL step traces). Created in `extension.ts` at the same time as `traceDir`, using the same timestamp so they pair clearly.

**`extension.ts` additions:**
```typescript
const sessionId  = Date.now();
const traceDir   = path.join(LTR_TMP_DIR, `traces-${sessionId}`);    // existing
const coverageDir = path.join(LTR_TMP_DIR, `coverage-${sessionId}`); // new

// Cleanup stale coverage dirs from previous sessions (same place as traces cleanup)
for (const entry of fs.readdirSync(LTR_TMP_DIR)) {
  if (entry.startsWith('coverage-')) {
    fs.rmSync(path.join(LTR_TMP_DIR, entry), { recursive: true, force: true });
  }
}

fs.mkdirSync(coverageDir, { recursive: true });
```

`coverageDir` is passed to `SessionManager` alongside `traceDir`, which passes it to `SessionTraceRunner`.

**Directory layout:**
```
LTR_TMP_DIR/
  traces-1744123456/           ← JSONL step traces per test (existing)
  coverage-1744123456/         ← all coverage data (new)
    manifests/                 ← per-source-file JSON manifests (written by transform)
      a1b2c3.json
    ltr-cov-<ts>-<rand>.jsonl  ← per-run counter JSONL (cleaned up after read)
```

```typescript
const manifestDir     = path.join(this._coverageDir, 'manifests');     // shared across all trace runs in session
const covCountersFile = path.join(this._coverageDir, `ltr-cov-${ts}-${rand}.jsonl`);  // unique per runFile()

fs.mkdirSync(manifestDir, { recursive: true });  // idempotent — safe with parallel runFile() calls

// Passed to this._executor.run({ extraEnv: { ... } })
extraEnv: {
  SESSION_TRACE_FILE:   rawTraceFile,
  COVERAGE_OUTPUT_FILE: covCountersFile,   // JSONL, unique per run, deleted after read
  LTR_MANIFEST_DIR:     manifestDir,       // shared — transform writes manifests here
}
```

### After the Jest run — read JSONL, merge, promote CoverageStore

```typescript
// Read JSONL counter file — one line per Jest worker
const rawLines = fs.existsSync(covCountersFile)
  ? fs.readFileSync(covCountersFile, 'utf8').split('\n').filter(l => l.trim())
  : [];

// Merge all workers' counters — sum within a single run, max() across runs (§25.1)
const mergedCov: Record<string, FileCov> = {};
for (const line of rawLines) {
  const { cov } = JSON.parse(line) as { workerPid: number; cov: Record<string, FileCov> };
  for (const [hash, fileCov] of Object.entries(cov)) {
    if (!mergedCov[hash]) {
      mergedCov[hash] = fileCov;
    } else {
      // Sum counters within a single run (workers ran different tests in the same file)
      for (const [id, val] of Object.entries(fileCov.s)) {
        mergedCov[hash].s[id] = (mergedCov[hash].s[id] ?? 0) + val;
      }
      for (const [id, arms] of Object.entries(fileCov.b)) {
        mergedCov[hash].b[id] = arms.map((v, i) => (mergedCov[hash].b[id]?.[i] ?? 0) + v);
      }
      for (const [id, val] of Object.entries(fileCov.f)) {
        mergedCov[hash].f[id] = (mergedCov[hash].f[id] ?? 0) + val;
      }
    }
  }
}

// Promote CoverageStore entries — merge with existing using max() for cross-run accumulation
for (const [fileHash, counters] of Object.entries(mergedCov)) {
  const manifestPath = path.join(manifestDir, `${fileHash}.json`);
  if (!fs.existsSync(manifestPath)) { continue; }  // manifest lost (tmpdir clean) — skip safely
  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Merge with existing entry (max per counter — preserves coverage from other tests, §25.1)
  const existing = this._coverageStore.getEntry(manifest.filePath);
  const merged = existing?.state === 'measured' || existing?.state === 'measured-stale'
    ? _mergeCounters(existing.counters, counters)
    : counters;

  const pct = CoverageReport.calculate(manifest, merged);
  this._coverageStore.setMeasuredEntry(manifest.filePath, { manifest, counters: merged, pct });
}

// Cleanup
try { fs.unlinkSync(covCountersFile); } catch { /* ignore */ }
```

```typescript
// Helper — merge two FileCov objects by taking max per counter (cross-run accumulation)
function _mergeCounters(a: FileCov, b: FileCov): FileCov {
  return {
    s: Object.fromEntries(Object.keys({ ...a.s, ...b.s }).map(id => [id, Math.max(a.s[id] ?? 0, b.s[id] ?? 0)])),
    b: Object.fromEntries(Object.keys({ ...a.b, ...b.b }).map(id => [id, (a.b[id] ?? []).map((v, i) => Math.max(v, b.b[id]?.[i] ?? 0))])),
    f: Object.fromEntries(Object.keys({ ...a.f, ...b.f }).map(id => [id, Math.max(a.f[id] ?? 0, b.f[id] ?? 0)])),
  };
}
```

`CoverageStore.setMeasuredEntry()` fires `onDidChange` → observers redraw badge + gutter.

---

## 18. `CoverageStore.ts` — full public API

```typescript
export class CoverageStore {
  // ── Writes (called by SourceCounter + SessionTraceRunner) ──────────────────

  /** Called by SourceCounter for every source file */
  setCountedEntry(filePath: string, counts: { statements: number; branches: number; functions: number; lines: number }): void

  /** Called by SessionTraceRunner after each trace run */
  setMeasuredEntry(filePath: string, data: { manifest: Manifest; counters: LiveCov; pct: CoveragePct }): void

  /** v1: called by SessionManager.onSave — marks the entire file stale */
  markFileStale(filePath: string): void

  /** v2 (DiffChecker): mark only the changed function's line range stale */
  markStale(filePath: string, startLine: number, endLine: number): void  // NOT implemented in v1

  /** Called by SessionTraceRunner when a stale entry is re-measured (setMeasuredEntry clears stale implicitly) */
  clearStale(filePath: string): void

  /** Called on session stop and on session restart before new SourceCounter run */
  clear(): void

  // ── Reads (called by CoverageReport + UI) ─────────────────────────────────

  getEntry(filePath: string): CoverageEntry | undefined
  getAllEntries(): IterableIterator<[string, CoverageEntry]>
  getTotals(): CoverageTotals          // recalculated on each call (fast — one pass)
  isScanComplete(): boolean            // true once SourceCounter emits 'done'
  isAllMeasured(): boolean             // true when no 'counted' entries remain

  // ── Events ─────────────────────────────────────────────────────────────────
  readonly onDidChange: vscode.EventEmitter<void>   // fired on any entry mutation
}
```

`getTotals()` is not cached — called infrequently (only when badge renders). Keeping it uncached avoids any invalidation bugs.

---

## 19. `CoverageReport.ts` — metric calculation

Stateless utility. No class needed — export named functions.

```typescript
/** Calculate four coverage metrics from a manifest + live counters */
export function calculate(manifest: Manifest, counters: FileCov): CoveragePct {
  const stmts   = Object.keys(manifest.statements);
  const covered  = stmts.filter(id => counters.s[id] > 0).length;

  const branchArms  = Object.values(manifest.branches).flatMap(b => b.arms);  // array of arm counts
  const branchTotal = branchArms.reduce((acc, arms) => acc + arms, 0);
  const branchCov   = Object.entries(manifest.branches).reduce((acc, [id, b]) => {
    return acc + counters.b[id].filter(n => n > 0).length;
  }, 0);

  const fns    = Object.keys(manifest.functions);
  const fnsCov = fns.filter(id => counters.f[id] > 0).length;

  // Lines: unique lines with ≥1 executed statement
  const allLines   = new Set(Object.values(manifest.statements).map(s => s.start.line));
  const covLines   = new Set(
    stmts.filter(id => counters.s[id] > 0).map(id => manifest.statements[id].start.line)
  );

  return {
    statements: { covered, total: stmts.length,    pct: pct(covered, stmts.length) },
    branches:   { covered: branchCov, total: branchTotal, pct: pct(branchCov, branchTotal) },
    functions:  { covered: fnsCov, total: fns.length,  pct: pct(fnsCov, fns.length) },
    lines:      { covered: covLines.size, total: allLines.size, pct: pct(covLines.size, allLines.size) },
  };
}

function pct(covered: number, total: number): number {
  return total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;  // 1 decimal place
}
```

---

## 20. `DiffChecker.ts` — **DEFERRED (post v1)**

> **Status: design complete, implementation deferred until basic coverage is tested end-to-end.**
>
> **Why deferred:** To make function-level stale marking actually useful (showing grey gutter only on changed functions, not the whole file), the system needs to know which tests cover which *functions* — not just which tests cover the file. That means `sourceToTests` (in `ExecutionTraceStore`) would need to store per-function granularity rather than per-file. That is a scope increase on top of the core coverage feature. The safer path: ship aggregate coverage first, validate the gutter decorations with whole-file stale marking, then add function-level precision in a follow-up.
>
> **For v1:** On save, the entire file's `CoverageStore` entry is marked `'measured-stale'` (no function boundary detection). The rerun clears it back to `'measured'`. Simple and correct.

### Design (preserved for the follow-up)

`DiffChecker` does a function-level AST diff between the last-known boundaries and the new file content. It returns changed `FunctionBoundary[]` (added, deleted, body-hash changed).

```typescript
export class DiffChecker {
  private _lastBoundaries = new Map<string, FunctionBoundary[]>();

  diff(filePath: string, newContent: string): FunctionBoundary[] {
    const newBoundaries = this._parse(newContent, filePath);
    const oldBoundaries = this._lastBoundaries.get(filePath) ?? [];
    this._lastBoundaries.set(filePath, newBoundaries);
    return this._findChanged(oldBoundaries, newBoundaries);
  }

  private _parse(content: string, filePath: string): FunctionBoundary[] { /* AST walk */ }

  private _findChanged(old: FunctionBoundary[], next: FunctionBoundary[]): FunctionBoundary[] {
    const oldMap = new Map(old.map(b => [b.key, b]));
    const changed: FunctionBoundary[] = [];
    for (const b of next) {
      const prev = oldMap.get(b.key);
      if (!prev || prev.bodyHash !== b.bodyHash) { changed.push(b); }
    }
    const nextKeys = new Set(next.map(b => b.key));
    for (const b of old) {
      if (!nextKeys.has(b.key)) { changed.push(b); }
    }
    return changed;
  }
}
```

**What the follow-up needs before DiffChecker is useful:**
1. `sourceToTests` extended to store per-function coverage data (which test cases executed which functions).
2. `CoverageStore.markStale()` takes `startLine`/`endLine` and marks only those lines — not the whole file.
3. Rerun scoping can then target only tests that covered the changed function (narrower than current file-level scope).

### v1 stale marking (simple replacement)
```typescript
// SessionManager.onSave() — v1 only
if (!this._adapter.isTestFile(document.uri.fsPath)) {
  this._coverageStore.markFileStale(document.uri.fsPath);  // whole file
  this._notify('onCoverageUpdated');
}
// ... existing rerun logic unchanged ...
```

---

## 21. `IResultObserver` — new coverage methods

```typescript
export interface IResultObserver extends vscode.Disposable {
  // ... existing methods ...

  /** Fired by SourceCounter as it scans. scanned/total drive the spinner. */
  onSourceScanProgress?(scanned: number, total: number): void;

  /** Fired when SourceCounter finishes. CoverageStore is fully populated with 'counted' entries. */
  onSourceScanDone?(): void;

  /** Fired after any CoverageStore mutation — badge + gutter redraw. */
  onCoverageUpdated?(): void;
}
```

`ExplorerView`, `CoverageDecorationManager`, and any future per-file coverage view all implement these. `SessionManager._notify()` drives them uniformly — no special-casing needed.

---

## 22. UI — webview message protocol additions

### New messages: extension → webview

```typescript
// Source scan progress (drives spinner counter)
{ type: 'source-scan-progress', scanned: number, total: number }

// Source scan finished (removes spinner, shows 0% badge if no tests done yet)
{ type: 'source-scan-done' }

// Coverage updated (replaces badge content)
{
  type: 'coverage-updated',
  totals: {
    statements: { covered: number, total: number, pct: number },
    branches:   { covered: number, total: number, pct: number },
    functions:  { covered: number, total: number, pct: number },
    lines:      { covered: number, total: number, pct: number },
  },
  isPartial: boolean,    // true if SourceCounter not yet done
  hasStale:  boolean,    // true if any 'measured-stale' entries exist
}
```

No new messages webview → extension needed for coverage v1 (aggregate only, no per-file drill-down).

### Coverage section HTML structure (in `explorer.html`)

```html
<div id="coverage-section" class="hidden">

  <!-- State A: scanning in progress -->
  <div id="cov-scanning" class="hidden">
    <span class="spinner"></span>
    <span id="cov-scan-label">Scanning source files… 0 / 40</span>
  </div>

  <!-- State B: updating after test run -->
  <div id="cov-updating" class="hidden">
    <span class="spinner"></span>
    <span>Updating coverage…</span>
  </div>

  <!-- State C: badge (always rendered, hidden until first data) -->
  <div id="cov-badge" class="hidden">
    <span class="cov-metric" id="cov-stmts">Stmts —</span>
    <span class="cov-metric" id="cov-branches">Branches —</span>
    <span class="cov-metric" id="cov-fns">Fns —</span>
    <span class="cov-metric" id="cov-lines">Lines —</span>
    <span id="cov-stale-indicator" class="hidden" title="Some files changed — rerunning">↻</span>
  </div>

</div>
```

### Webview JS state machine
```
session not started         → #coverage-section hidden
session started             → #coverage-section visible
  SourceCounter running     → #cov-scanning visible
  SourceCounter done,       → #cov-scanning hidden
    tests still running     → #cov-updating visible
  All done                  → #cov-updating hidden, #cov-badge visible
  File saved, rerun active  → #cov-stale-indicator visible on badge
  Rerun done                → #cov-stale-indicator hidden, badge values updated
```

Each `coverage-updated` message always re-renders all four metric `<span>`s. The webview does not do partial updates — simpler and avoids stale UI.

---

## 23. `CoverageDecorationManager.ts` — gutter decorations

### Decoration types (created once at session start)

```typescript
private _types = {
  coveredLine:   vscode.window.createTextEditorDecorationType({
    gutterIconPath: this._icon('cov-hit'),      // green dot
    gutterIconSize: 'contain',
  }),
  staleLine:     vscode.window.createTextEditorDecorationType({
    gutterIconPath: this._icon('cov-stale'),    // grey dot
    gutterIconSize: 'contain',
    opacity: '0.4',
  }),
  soleCoverage:  vscode.window.createTextEditorDecorationType({
    gutterIconPath: this._icon('cov-sole'),     // orange warning dot
    gutterIconSize: 'contain',
  }),
};
```

A fourth `uncoveredLine` type exists but is only activated when the user toggles the opt-in setting `liveTestRunner.showUncoveredLines: true`.

### `applyToEditor(editor)` logic
```
1. Get CoverageEntry for editor.document.uri.fsPath
2. If no entry → clear all decorations, return
3. If entry.state === 'counted' → clear all decorations, return (0% but no line data)
4. If entry.state === 'measured' or 'measured-stale':
   a. Build coveredRanges: lines where s[id] > 0
   b. Build staleRanges: if 'measured-stale', the markStale() range from CoverageStore
   c. Build soleCoverageRanges: lines where only one test covers the branch/fn
   d. Apply each decoration type — VSCode merges gutter icons; stale takes priority visually
```

### Stale range priority
If a line is both covered and stale, stale wins — the grey dot communicates "don't trust this until the rerun completes."

### `onCoverageUpdated()` — IResultObserver implementation
```typescript
onCoverageUpdated(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    this.applyToEditor(editor);
  }
}
```

No full refresh of all editors — only visible ones. Non-visible editors get decorated when they open (via `vscode.window.onDidChangeActiveTextEditor`).

---

## 24. `SessionManager` constructor additions

`CoverageStore` and `SourceCounter` are created and owned by `SessionManager`. They are passed to `SessionTraceRunner` and `CoverageDecorationManager` via constructor injection (same pattern as `ExecutionTraceStore`).

> **`DiffChecker` is deferred to v2.** It is NOT wired in v1. `SessionManager.onSave()` calls `coverageStore.markFileStale()` directly — no `DiffChecker` constructor param, no import.

`extension.ts` changes:
```typescript
const coverageStore = new CoverageStore();
const covDecoMgr    = new CoverageDecorationManager(coverageStore, context);
observers.push(covDecoMgr);

const sessionManager = new SessionManager(
  adapter, store, traceStore, coverageStore,
  selection, resultsView, observers, outputChannel, statusBar,
  discovery, traceDir,
);
```

`CoverageDecorationManager` is added to the `observers` array — it receives all lifecycle events without any special-casing in `extension.ts`.

### `CoverageStore.clear()` call sites
- `SessionManager.stop()` — called alongside `this._store.clearAllLineMaps()`. Clears store so stale data is not shown if session is stopped.
- `SessionManager.start()` — called **before** firing `SourceCounter`, so restarting a session begins with a clean slate. Order: `clear()` → `activate()` → `void sourceCounter.run()` → `_runFiles()`.

`CoverageStore.clear()` also resets `isScanComplete()` to `false` so the spinner re-appears on restart.

---

## 25. Open questions and edge cases

### 25.1 Coverage accuracy on partial reruns — **DECIDED: merge with `max`**

**The problem:** When a source file is saved, only affected tests rerun. The new `COVERAGE_OUTPUT_FILE` only contains counters from the just-run tests. Naively replacing the whole entry loses coverage data from other tests that previously covered the file.

**Decision: merge with `max` per counter ID.**
```
merged[id] = Math.max(existing[id] ?? 0, new[id] ?? 0)
```

- If logic didn't change (formatter save): old coverage is still valid, merge is correct.
- If logic changed: diff checker already marks the function stale. Badge shows stale indicator. When the rerun finishes, new counters replace old ones for those function lines.
- The `max` is safe: a counter can only meaningfully decrease if the code path was deleted, which the diff checker catches and marks stale.

**Remaining gap:** Deleted functions — stale mark covers them. After rerun, the rewritten manifest no longer includes the deleted function, so those lines simply have no decoration. Correct behaviour.

---

### 25.2 SourceCounter scope — what counts as a "source file" — **DECIDED: configurable with defaults**

**Include:** `**/*.{js,ts,jsx,tsx}` under `projectRoot`

**Default exclude list (hardcoded baseline):**
- `**/node_modules/**`
- `**/*.{test,spec}.{js,ts,jsx,tsx}`
- `**/*.config.{js,ts,mjs,cjs}`
- `**/*.d.ts`
- `dist/**`, `build/**`, `out/**`, `.next/**`, `coverage/**`
- `.git/**`

**User override via settings** (extends the default list, does not replace it):
```json
"liveTestRunner.coverageExclude": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "description": "Additional glob patterns to exclude from coverage scanning (extends built-in defaults)."
}
```

`SourceCounter` merges `defaultExcludes.concat(userExcludes)` before globbing.

---

### 25.3 Jest transform cache and manifest freshness

`sessionTraceTransform.js` writes the manifest at transform time. Jest caches transform output. On subsequent runs of the same unchanged file, the transform does NOT re-run — the manifest is NOT rewritten.

This is correct behaviour: if the file hasn't changed, the old manifest is still valid. But we need to verify the manifest file still exists on disk before reading it (a `tmpdir` cleanup could remove it between runs). If missing → re-run the file to regenerate it, or fall back to `SourceCounter` counts.

**Proposed guard in `SessionTraceRunner`:**
```typescript
if (!fs.existsSync(manifestPath)) {
  // Manifest was lost (tmpdir cleaned) — stay 'counted', do not promote to 'measured'
  emit(`[Coverage] Manifest missing for ${filePath}, skipping promotion`);
  continue;
}
```

This is safe: the file will be re-measured on the next run that touches it.

---

### 25.4 SourceCounter re-run on session restart

`CoverageStore.clear()` is called on session stop. On next `SessionManager.start()`, a new `SourceCounter` runs. This is correct — project files may have changed between sessions.

A partial optimisation (v2): diff the file list against last session and only re-count changed files. Not needed for v1.

---

### 25.5 Multi-worker Jest coverage aggregation — **DECIDED: JSONL append, parallel file runs kept**

**The problem:** Each `SessionTraceRunner.runFile()` call runs Jest with `--maxWorkers=2`. Two workers both call `process.on('exit')` and both write to the same `COVERAGE_OUTPUT_FILE` — last one wins, the other's data is lost.

**Decision: JSONL append (mirrors how trace cache dirs solved the same race for transforms).**

Each worker appends one line:
```
{"workerPid":1234,"cov":{"<hash>":{"s":{"s0":3},"b":{"b0":[1,0]},"f":{"f0":2}}}}
{"workerPid":5678,"cov":{"<hash>":{"s":{"s0":0},"b":{"b0":[0,1]},"f":{"f0":0}}}}
```

In `sessionTraceRuntime.js` on exit:
```js
process.on('exit', () => {
  const covFile = process.env.COVERAGE_OUTPUT_FILE;
  if (!covFile || !globalThis.__cov) { return; }
  try {
    fs.appendFileSync(covFile, JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n', 'utf8');
  } catch (_e) {}
});
```

`SessionTraceRunner` after the Jest run: read all lines → merge counter arrays by summing (not `max` — within a single run all hits are additive):
```typescript
for (const line of covLines) {
  const { cov } = JSON.parse(line);
  for (const [hash, fileCov] of Object.entries(cov)) {
    merge(accumulated[hash], fileCov);  // sum s/f counters, sum b arm arrays
  }
}
```

**File-level parallelism (TRACE_CONCURRENCY) is unchanged** — each `runFile()` gets its own unique `covCountersFile` path, so parallel file runs never touch the same file. The JSONL race only exists within a single file's Jest run (between its workers), which the append solves.

---

### 25.6 `__cov` counter collision between test files in the same worker

`globalThis.__cov` is keyed by file hash. Multiple test files in the same worker will each add their file's key. No collision — accumuluation across files is intentional (we want the union of all lines hit).

No issue here — confirming for completeness.

---

### 25.7 Sole-coverage detection — deferred detail

The plan mentions sole-coverage warnings but doesn't specify how to detect "only one test covers this branch." This requires a per-branch → [test names] mapping, which isn't tracked in `CoverageStore` v1 (which only stores aggregate counters).

**Proposal for v1:** Sole-coverage is shipped as UI-only skeleton (gutter type exists, no lines decorated). Full implementation deferred to a follow-up that adds per-test counter storage.

---

## 26. Configuration additions (`package.json` contributes)

Coverage is always on — no enable/disable toggle. The infra is non-blocking and has no UI performance impact.

```json
"liveTestRunner.showUncoveredLines": {
  "type": "boolean",
  "default": false,
  "description": "Show gutter decorations on lines with no coverage (opt-in)."
},
"liveTestRunner.coverageExclude": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "description": "Additional glob patterns to exclude from coverage scanning (extends built-in defaults)."
},
"liveTestRunner.coverageThresholds": {
  "type": "object",
  "default": { "high": 80, "medium": 50 },
  "description": "Coverage percentage thresholds for colour coding. At or above 'high' → green. Between 'medium' and 'high' → yellow. Below 'medium' → red."
}
```

---

## 27. Scope boundary — Timeline Debugger

**The Timeline Debugger (`JestInstrumentedRunner`, `TimelineDecorationManager`, `TimelineStore`, `TimelineEvent`) is NOT to be touched during this implementation.** It is slated for a complete rewrite separately.

Concretely:
- Do NOT modify `traceTransform.js` (Timeline's transform) — only modify `sessionTraceTransform.js`
- Do NOT modify `traceRuntime.js` (Timeline's runtime) — only modify `sessionTraceRuntime.js`
- Do NOT modify `JestInstrumentedRunner.ts`, `TimelineDecorationManager.ts`, `TimelineStore.ts`, or `TimelineEvent.ts`
- The existing `IInstrumentedRunner` interface stays unchanged
- `extension.ts` Timeline wiring stays unchanged

---

## 28. UI Design — Coverage in Explorer (main view)

### Coverage summary row
Sits below the existing test summary (total/passed/failed). A compact 4-column row:

```
┌──────────────────────────────────────────────────────┐
│  Stmts   Branches    Fns    Lines                     │
│   87%      72%       91%     89%        Explore ›     │
└──────────────────────────────────────────────────────┘
```

- Each metric label + percentage in its own cell.
- Each percentage is **colour-coded** (green / yellow / red — thresholds from §29).
- "Explore ›" button routes to the Coverage Explorer page (uses existing webview router).
- The whole row uses the same card / section styling as the rest of the explorer panel.

### Loading states in main view

| State | What shows |
|---|---|
| Session not started | Coverage row hidden |
| SourceCounter running | Row visible: spinner + `"Scanning… 14 / 40"` label instead of metric cells |
| Scan done, run in progress | Row visible: spinner + `"Updating coverage…"` |
| Both done | 4 metric cells + "Explore ›" |
| File saved, rerun active | Metric cells + small `↻` stale indicator, values from last completed run |

No progress bar — text counter only (`14 / 40`).

---

## 29. UI Design — Coverage Explorer page

### Routing

**Confirmed:** `router.js` (`src/webview/router.js`) is the existing shared single-page router. It listens for `{ type: 'route', view: string, payload?: object }` messages from the extension host and calls `view.mount(container, vscode, payload)` / `view.unmount()` on the registered view object. All other messages are forwarded to the currently active view via `view.onMessage(msg)`.

**How the Coverage Explorer plugs in:**

`explorer.html` already loads `router.js` via `{{routerUri}}` and registers its views at init:
```js
Router.init({
  vscode,
  views: {
    testList:        TestListView,
    timelineSidebar: TimelineSidebar,
    coverageExplorer: CoverageExplorerView,   // ← add this
  },
  defaultView: 'testList',
});
```

The "Explore ›" button in `TestListView` posts to the extension:
```js
vscode.postMessage({ type: 'open-coverage-explorer' });
```

The extension host (`ExplorerView.handleExtraMessage`) replies with a route message:
```typescript
if (msg.type === 'open-coverage-explorer') {
  this.postMessage({ type: 'route', view: 'coverageExplorer', payload: {} });
  // Also send the full entry list immediately after routing
  this.postMessage({ type: 'coverage-explorer-init', entries: [...], thresholds: {...} });
}
```

The back button in `CoverageExplorerView` posts `{ type: 'navigate-back' }` → extension replies `{ type: 'route', view: 'testList' }`.

**No new HTML file needed.** `CoverageExplorerView` is a new JS view object (`src/webview/views/coverageExplorerView.js`) that renders into the existing `#app` container — same pattern as `TestListView` and `ResultsView`. The router clears `innerHTML` on each route switch.

### Page layout (top to bottom)

```
┌─────────────────────────────────────────────────────────┐
│  ← Back          Code Coverage           [%] ↔ [N/M]   │
├─────────────────────────────────────────────────────────┤
│  Stmts 87%   Branches 72%   Fns 91%   Lines 89%        │
├─────────────────────────────────────────────────────────┤
│  🔍 Search files…                    [Low coverage ▼]   │
│                                                          │
│  ▼ src/                                                  │
│     ▼ utils/                                             │
│        formatDate.ts    95%    100%   100%    95%        │
│        parseQuery.ts    42%     33%    50%    40%  ⚠    │
│     ▷ components/                                        │
│  ▷ lib/                                                  │
└─────────────────────────────────────────────────────────┘
```

### Header bar
- **Back button** (`← Back`) — always top-left, routes to main view.
- **Page title** (`Code Coverage`) — centred.
- **Metric toggle** — top-right: `%` / `N/M` pill toggle. Switches ALL displayed values globally. Persisted in webview state (survives panel hide/show within the session).

### Summary strip
Same 4-column row as the main view. Updates on every `coverage-updated` message. Shows the stale indicator (`↻`) if any entries are stale.

### Search bar
- Plain text input, `🔍` icon prefix.
- Filters the file tree in real-time (client-side filter on display names, no round-trip).
- Matches on file name AND relative path — searching `utils` matches `src/utils/formatDate.ts`.
- Clearing the search restores the full tree with expand/collapse state preserved.

### Quick filter button
- "Low coverage ▼" dropdown with options:
  - **All files** (default)
  - **Low coverage** — files where any metric is below the `medium` threshold
  - **Uncovered** — files at 0% statements
  - **Stale** — files with `'measured-stale'` state
- Active filter shown as a filled chip: `Low coverage ×`

### File tree (Coverage By File)

**Structure:** Folder-first hierarchy matching the source file layout. Same expand/collapse pattern as `TestListLayout`.
- Folders show a **rolled-up aggregate** for all children in the same 4 columns.
- Folders start **expanded**. User can collapse. State is not persisted between sessions.
- "Collapse all / Expand all" icons in the section header.

**Table columns:**

| Column | Content |
|---|---|
| File name | Basename only (no full path). Tooltip on hover shows full relative path. Indented per depth level. |
| Stmts | `87%` or `23 / 26` depending on toggle |
| Branches | same |
| Fns | same |
| Lines | same |

Column headers are **sortable** — click to sort ascending, click again descending. Default sort: alphabetical by file name. An arrow icon shows active sort column and direction.

**Colour coding per cell:**

| Threshold | Colour | CSS class |
|---|---|---|
| ≥ `high` (default 80%) | Green | `cov-high` |
| ≥ `medium` (default 50%) | Yellow/Amber | `cov-medium` |
| < `medium` | Red | `cov-low` |

Colour applies to the percentage/counter value only — not the full row. The file name cell has no colour.

Zero-coverage files (0% statements) get a subtle red tint on the entire row to make them stand out.

**Configurable thresholds** (§26 settings):
```json
"liveTestRunner.coverageThresholds": {
  "type": "object",
  "default": { "high": 80, "medium": 50 },
  "description": "Coverage percentage thresholds for colour coding. Values below 'medium' show red, between 'medium' and 'high' show yellow, at or above 'high' show green."
}
```

### Hover actions (per file row)

On mouse-over, a small action bar appears at the right edge of the row (same pattern as `TestListLayout`):

| Action | Icon | Behaviour |
|---|---|---|
| Go to file | `↗` | Opens the source file in the editor |
| Expand / Collapse | `▼` / `▷` | Toggles folder (folder rows only) |

No "run tests" action in this view — coverage view is read-only. Re-runs are triggered by saving files.

### `'counted'` files (untouched by tests)
Displayed as `0%` in all metric cells — consistent with the metric toggle (N/M mode shows `0 / N`). This is correct: 0 lines covered is 0%. Tooltip on hover: `"No tests have imported this file yet"`. They appear at the bottom of their folder group when sorted by coverage (below measured files) and are coloured red (below medium threshold).

### `'measured-stale'` files
Metric values shown normally, but a `↻` icon appears after the file name. Tooltip: `"Coverage may be outdated — tests are rerunning"`.

### Empty state
If no files in `CoverageStore` yet (SourceCounter still running): show a spinner centred in the list area. Same scan progress text as the main view.

---

## 30. Additional UI features

| Feature | Description | Priority |
|---|---|---|
| **Sort by column** | Click any of the 4 metric headers to sort ascending/descending | Include in v1 |
| **Uncovered files filter** | Quick filter: show only 0% files | Include in v1 |
| **Rolled-up folder totals** | Folders show aggregate metrics for all children | Include in v1 |
| **Full relative path tooltip** | Hover file name → see `src/utils/formatDate.ts` | Include in v1 |
| **Zero-coverage row tint** | Subtle red background on 0% statement files | Include in v1 |
| **Stale file indicator** | `↻` icon on stale file rows | Include in v1 |
| **File detail page** | Click file row → Coverage Explorer page 2 with test list + issues (§35) | v2 — needs line→test index |
| **Per-function breakdown** | Expand to show which functions are uncovered | Defer — needs per-function store |
| **Coverage trend delta** | `▲ +3%` / `▼ -1%` deltas vs last session | Defer (§8.5) |
| **Export report** | Download CSV or JSON | Defer |

---

## 31. Webview messages — Coverage Explorer additions

### Extension → webview

```typescript
// Send full file list to the coverage explorer page on navigation
{
  type: 'coverage-explorer-init',
  entries: Array<{
    filePath: string,       // absolute path (for Go To File action)
    relativePath: string,   // display path relative to projectRoot
    state: 'counted' | 'measured' | 'measured-stale',
    pct: CoveragePct | null,       // null if state === 'counted'
    counts: { statements: number, branches: number, functions: number, lines: number } | null,
    totals: { statements: number, branches: number, functions: number, lines: number },
  }>,
  thresholds: { high: number, medium: number },
}

// Incremental update — same shape as coverage-updated but includes per-file entries
{
  type: 'coverage-explorer-update',
  totals: CoverageTotals,
  changed: Array<{ filePath: string, state, pct, counts, totals }>,
  hasStale: boolean,
}
```

### Webview → extension

```typescript
// Open a source file in the editor
{ type: 'open-file', filePath: string }
```

---

## 32. Git commit plan

Each commit is a clean, independently-reviewable unit. Build and tests should pass after each one.

```
Commit 1  — chore: add coverage types and CoverageStore
  Files: src/coverage/CoverageStore.ts (new)
         src/coverage/types.ts (new — Manifest, LiveCov, CoveragePct, CoverageTotals, CoverageEntry)

Commit 2  — feat: add SourceCounter background source file scan
  Files: src/coverage/SourceCounter.ts (new)
         IResultObserver.ts (add onSourceScanProgress, onSourceScanDone)

Commit 3  — feat: extend sessionTraceTransform with __cov counter injection and manifest write
  Files: src/session/instrumentation/sessionTraceTransform.js (modified)

Commit 4  — feat: extend sessionTraceRuntime with JSONL coverage flush on exit
  Files: src/session/instrumentation/sessionTraceRuntime.js (modified)

Commit 5  — feat: add CoverageReport metric calculation
  Files: src/coverage/CoverageReport.ts (new)

Commit 6  — feat: extend SessionTraceRunner to set coverage env vars and promote CoverageStore
  Files: src/session/SessionTraceRunner.ts (modified)

Commit 7  — feat: wire coverage into SessionManager (SourceCounter on start, whole-file stale on save)
  Files: src/session/SessionManager.ts (modified)
         IResultObserver.ts (add onCoverageUpdated)
  Note: DiffChecker is DEFERRED to v2 — SessionManager calls coverageStore.markFileStale() directly, no DiffChecker import or constructor param
  Note: Commit 8 is intentionally absent — it was reserved for DiffChecker wiring which is deferred

Commit 9  — feat: add CoverageDecorationManager for gutter coverage decorations
  Files: src/editor/CoverageDecorationManager.ts (new)
         src/extension.ts (wire into observers)

Commit 10 — feat: add coverage summary row and states to main explorer view
  Files: src/views/ExplorerView.ts (modified)
         media/explorer.html (modified)
         media/explorer.js (modified)

Commit 11 — feat: add Coverage Explorer view (new router view, no new HTML file)
  Files: src/webview/views/coverageExplorerView.js (new — implements mount/unmount/onMessage)
         src/webview/explorer.html (register coverageExplorer in Router.init views map)
         src/views/ExplorerView.ts (handle open-coverage-explorer, navigate-back, open-file messages)

Commit 12 — feat: add coverage settings to package.json
  Files: package.json (showUncoveredLines, coverageExclude, coverageThresholds)

Commit 13 — chore: update docs for 1.2.0 coverage feature
  Files: docs/ai-context.md, docs/architecture.md, docs/developer-guide.md,
         CHANGELOG.md, README.md, packages/vscode-extension/README.md
```

---

## 33. Documents to update on completion

Update these **after implementation is complete and tested**, not before.

| Document | What to add/update |
|---|---|
| `docs/ai-context.md` | New coverage system: CoverageStore, SourceCounter, DiffChecker, CoverageReport, CoverageDecorationManager. New env vars. New webview route. |
| `docs/architecture.md` | Add `coverage/` package diagram. Explain two-track architecture (SourceCounter + test run). Describe CoverageStore entry lifecycle. |
| `docs/developer-guide.md` | How to work on coverage: extending the transform, adding new metrics, testing SourceCounter. How the manifest/counter pairing works. |
| `CHANGELOG.md` | Version `1.2.0` entry — feature description for end users (not implementation detail). |
| `README.md` | Add code coverage section: what it shows, how to use the explorer, the colour thresholds, opt-in settings. |
| `packages/vscode-extension/README.md` | **[PLACEHOLDER]** VS Code Marketplace readme — add coverage badge screenshot placeholder, bullet point for code coverage feature, list the new settings. |

---

## 34. New chat handoff template

Use this when the conversation becomes too large or token-heavy. Paste it into a new chat verbatim.

---

```
# Live Test Runner — Code Coverage Implementation Handoff

## What this is
We are implementing code coverage (v1.2.0) for the Live Test Runner VS Code extension.
The full design doc is at: /Users/eshandias/Projects/Personal/live-test-runner/docs/code-coverage-plan.md
Read it in full before starting. It is the source of truth.

## Project structure
- packages/vscode-extension/src/  — all extension TypeScript
- packages/vscode-extension/src/session/instrumentation/  — sessionTraceTransform.js + sessionTraceRuntime.js (DO NOT touch traceTransform.js or traceRuntime.js — those belong to the Timeline Debugger which is out of scope)
- packages/vscode-extension/src/session/SessionManager.ts  — session lifecycle
- packages/vscode-extension/src/session/SessionTraceRunner.ts  — runs instrumented Jest, reads traces
- packages/vscode-extension/src/store/ExecutionTraceStore.ts  — existing trace store (reference, do not modify for coverage)
- packages/vscode-extension/src/IResultObserver.ts  — observer interface (needs coverage methods added)
- packages/vscode-extension/src/extension.ts  — activation and wiring

## New files to create
src/coverage/
  types.ts                — Manifest, LiveCov, FileCov, CoveragePct, CoverageTotals, CoverageEntry
  CoverageStore.ts        — in-memory store, fires onDidChange
  SourceCounter.ts        — background AST scan at session start (uses vscode.workspace.findFiles)
  CoverageReport.ts       — stateless metric calculation
  DiffChecker.ts          — NOT created in v1 (full design in §20, deferred to v2)
src/editor/
  CoverageDecorationManager.ts  — gutter decorations (green heatmap, grey stale, sole-coverage stub)
src/webview/views/
  coverageExplorerView.js — new router view (no new HTML file — uses existing explorer.html + router.js)

## Key decisions (all closed — do not re-open)
- Coverage always on — no enable/disable toggle
- Counter write race (multi-worker): JSONL appendFileSync per worker pid, merged in SessionTraceRunner (§25.5)
- Cross-run merge: max() per counter ID (§25.1)
- SourceCounter uses vscode.workspace.findFiles — no new glob dep (§14)
- coverageDir = separate session-scoped dir (`coverage-${sessionId}`), created in extension.ts alongside traceDir. manifestDir = path.join(coverageDir, 'manifests') (§17)
- DiffChecker deferred to v2: NOT wired in v1. SessionManager.onSave() calls coverageStore.markFileStale() directly — no DiffChecker param (§20, §24)
- Sole-coverage deferred to v2 (§25.7)
- 'counted' files show 0% not — (§29)
- Totals not shown until SourceCounter finishes — prevents inflated percentage (§3)
- Timeline Debugger: NOT to be touched — only modify sessionTraceTransform.js and sessionTraceRuntime.js (§27)
- Babel parser: errorRecovery:true in SourceCounter to survive mid-edit syntax errors (§14)
- CoverageStore.clear() called on both stop() and start() (§24)

## What is done
[FILL IN COMPLETED COMMITS from §32 before pasting this handoff]

## What still needs doing
[FILL IN REMAINING COMMITS from §32]

## What failed / known issues
[FILL IN any errors encountered]

## Key references
- The plan doc: /Users/eshandias/Projects/Personal/live-test-runner/docs/code-coverage-plan.md
- Git commit plan: §32 of the plan doc
- Docs to update at the end: §33 of the plan doc
- UI design detail: §28–31, §35 of the plan doc
- Deferred features: §20 (DiffChecker), §35 (file detail panel), §36 (line→test index), §37 (coverage cliff)
```

---

## 35. Coverage File Detail Page — "Tests covering this file" (v2, deferred)

> **Status: design complete, implementation deferred until v1 dashboard and Coverage Explorer are working.**
> Requires the line→test reverse index (§36) which is not built in v1.

### Entry point
Click a file row in the Coverage Explorer file list → navigates to a new router view (`coverageFileDetailView`). Back button returns to Coverage Explorer (not main view).

### Layout — 2-column

```
┌──────────────────────────────────────────────────────────────┐
│  ← Coverage Explorer       src/utils/formatDate.ts           │
├──────────────────────────────────────────────────────────────┤
│  Stmts 87%   Branches 72%   Fns 91%   Lines 89%             │
├─────────────────────────┬────────────────────────────────────┤
│  Tests covering this    │  Coverage issues                   │
│  file                   │                                    │
│  ─────────────────────  │  ─────────────────────────────────│
│  ✓ auth.test.ts         │  ⚠ 3 functions never called       │
│    › login flow         │     handleExpiredToken  (ln 42)   │
│    › should reject…     │     parseTimezone        (ln 67)  │
│    › should allow…      │     formatRelative       (ln 89)  │
│                         │                                    │
│  ✗ session.test.ts      │  ⚠ 2 branch arms never taken     │
│    › token refresh      │     if (locale) line 34, false    │
│    › expired token  ✗   │     switch default, line 71       │
│                         │                                    │
│  [Go to test file ↗]    │                                    │
└─────────────────────────┴────────────────────────────────────┘
```

### Column 1 — Tests covering this file

**Data source:** `ExecutionTraceStore._sourceToTests[filePath]` — already gives us test file → suite → test case. The pass/fail status comes from `ResultStore`.

**Grouped by test file.** Each test file is a collapsible group (collapsed by default if all passing, expanded if any failing). Each test case row shows:
- Pass/fail icon (live — updates if tests rerun while panel is open)
- Test name (truncated with tooltip for long names)
- Hover action: "Go to test ↗" — opens the test file at the test's line number

**"Go to test file ↗"** at the bottom of each group opens the whole test file.

If no tests cover the file: `"No tests have imported this file yet"` empty state.

### Column 2 — Coverage issues

**Data source:** `CoverageStore` entry manifest + counters for this file.

Two subsections:

**Uncovered functions** — functions where `f[id] === 0`. Shows:
- Function name + line number (from manifest)
- Clicking the row opens the file at that line

**Uncovered branch arms** — branch arms where `b[id][arm] === 0`. Shows:
- Branch type (if/else, ternary, switch) + line number
- Which arm: `true arm`, `false arm`, `case 'x'`, `default`
- Clicking opens the file at that line

If the file is `'counted'` (no manifest yet): column 2 shows `"Run tests to see coverage issues"`.
If fully covered: column 2 shows `"No issues — all branches and functions covered ✓"`.

### Webview messages for this view

```typescript
// Extension → webview: send file detail when navigating to this view
{
  type: 'coverage-file-detail-init',
  filePath: string,
  relativePath: string,
  entry: CoverageEntry,
  tests: Array<{
    testFilePath: string,
    testFileRelative: string,
    suites: Array<{
      suiteName: string,
      testCases: Array<{ fullName: string, status: 'passed' | 'failed' | 'pending' }>
    }>
  }>,
  thresholds: { high: number, medium: number },
}

// Webview → extension: open file at line
{ type: 'open-file', filePath: string, line?: number }

// Webview → extension: back to coverage explorer
{ type: 'navigate-coverage-back' }
```

### Git commit (when implementing)

```
Commit (v2) — feat: add Coverage File Detail view
  Files: src/webview/views/coverageFileDetailView.js (new)
         src/webview/explorer.html (register coverageFileDetail in Router.init)
         src/views/ExplorerView.ts (handle coverage-file-detail open, navigate-coverage-back)
```

---

## 36. Line → test reverse index (v2, required for §35 and gutter hover)

> **Status: design complete, deferred to v2. Not needed for v1 dashboard.**

### What it is
A map from `(sourceFilePath, lineNumber)` → `Set<testName>`. Tells you exactly which tests executed a given line. Required for:
1. Gutter icon hover: "Line 42 covered by: auth.test.ts > login > should reject…"
2. Column 1 of the file detail page (§35) in per-line detail mode

### Where to build it
In `SessionTraceRunner._partitionAndStore()`, after the existing per-test step loop. Each `STEP` event has `{ file, line, testName }`. Build the reverse:

```typescript
// During _partitionAndStore
const lineToTests = new Map<string, Map<number, Set<string>>>();
// key: `${filePath}:${line}` → Set of testName strings

for (const [testName, steps] of byTest) {
  for (const step of steps) {
    if (step.type === 'STEP' && step.file && step.line != null) {
      const fileMap = lineToTests.get(step.file) ?? new Map();
      const testSet = fileMap.get(step.line) ?? new Set();
      testSet.add(testName);
      fileMap.set(step.line, testSet);
      lineToTests.set(step.file, fileMap);
    }
  }
}
// Store on ExecutionTraceStore via new method: setLineToTests()
```

### `ExecutionTraceStore` additions

```typescript
// New private field
private readonly _lineToTests = new Map<string, Map<number, Set<string>>>();

// Merge on each trace run (accumulate across runs)
mergeLineToTests(filePath: string, lineMap: Map<number, Set<string>>): void

// Query: used by HoverProvider and file detail view
getTestsForLine(filePath: string, line: number): string[]
```

### Gutter hover provider

```typescript
// Registered in extension.ts (new, activated with coverage feature)
vscode.languages.registerHoverProvider(
  { scheme: 'file', pattern: '**/*.{ts,js,tsx,jsx}' },
  new CoverageHoverProvider(traceStore, store)
);

class CoverageHoverProvider implements vscode.HoverProvider {
  provideHover(document, position): vscode.Hover | undefined {
    const line = position.line + 1;  // VSCode is 0-indexed, our store is 1-indexed
    const tests = this._traceStore.getTestsForLine(document.uri.fsPath, line);
    if (tests.length === 0) { return undefined; }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Covered by ${tests.length} test${tests.length > 1 ? 's' : ''}:**\n\n`);
    for (const t of tests.slice(0, 10)) {
      const status = this._resultStore.getTestStatus(t);
      const icon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '○';
      md.appendMarkdown(`${icon} ${t}\n\n`);
    }
    if (tests.length > 10) {
      md.appendMarkdown(`_…and ${tests.length - 10} more_`);
    }
    return new vscode.Hover(md);
  }
}
```

### Git commit (when implementing)

```
Commit (v2a) — feat: build line→test reverse index in SessionTraceRunner
  Files: src/session/SessionTraceRunner.ts
         src/store/ExecutionTraceStore.ts (new mergeLineToTests, getTestsForLine)

Commit (v2b) — feat: add CoverageHoverProvider for gutter line→test hover
  Files: src/editor/CoverageHoverProvider.ts (new)
         src/extension.ts (register hover provider)
```

---

## 37. Coverage cliff in VS Code Problems panel — decision note

### What it is
VS Code has a **Problems panel** (View → Problems, or Ctrl+Shift+M). This is where TypeScript errors, ESLint warnings, and other diagnostics appear. Extension code can add entries to it via `vscode.languages.createDiagnosticCollection('coverage')`. Entries look like this in the Problems panel:

```
⚠  Coverage: statements 42% — below threshold 50%     src/utils/formatDate.ts
⚠  Coverage: branches 28% — below threshold 50%       src/api/authHandler.ts
```

Clicking an entry opens the file. The warnings disappear when coverage goes above the threshold.

### How it works technically
```typescript
const diagCollection = vscode.languages.createDiagnosticCollection('coverage');

// After each coverage update, for every file below threshold:
const diags: [vscode.Uri, vscode.Diagnostic[]][] = [];
for (const [filePath, entry] of coverageStore.getAllEntries()) {
  if (entry.state !== 'measured') { continue; }
  const issues: vscode.Diagnostic[] = [];
  if (entry.pct.statements.pct < thresholds.medium) {
    issues.push(new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `Coverage: statements ${entry.pct.statements.pct}% — below threshold ${thresholds.medium}%`,
      vscode.DiagnosticSeverity.Warning,
    ));
  }
  if (issues.length) { diags.push([vscode.Uri.file(filePath), issues]); }
}
diagCollection.set(diags);
```

### Pros
- Zero UI work — plugs into VS Code's existing Problems infrastructure
- Works with the standard dev workflow — coverage issues appear alongside lint errors
- Clickable to navigate to the file
- Disappears automatically when coverage improves

### Cons
- Coverage warnings mixed with TypeScript/ESLint errors in one panel — could feel noisy or confusing
- Diagnostics are file-level (line 0) — no specific line to jump to, just opens the file
- If a project has 20 files below threshold, Problems panel becomes crowded

### Decision
**Defer to v2.** The Coverage Explorer's colour coding and the file detail page (§35) give the user the same information with better context. Add the Problems panel integration only if users ask for it — it's a preference question (some developers live in the Problems panel, others don't use it).

**If implemented:** add a setting `liveTestRunner.coverageProblemsPanel: boolean` (default `false`) so users opt in. Never on by default.
