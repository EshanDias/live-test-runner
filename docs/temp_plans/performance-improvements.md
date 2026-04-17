# Performance Improvement Plan — Live Test Runner

> **Goal:** Make the extension viable for projects with 1k–10k+ test files without burning CPU/memory, while preserving the custom instrumentation that enables features no framework-native tooling can provide (timeline debugger, per-test dependency mapping, variable capture).

---

## Context & Design Principles

1. **Custom AST instrumentation is a strategic asset — but tiered.**
   - **Always on (light trace):** per-test line hits only. Stored as `Map<filename, Set<lineNumber>>`. No step order, no variables, no call stacks. Cheap to collect, cheap to store. This single structure serves two purposes:
     1. **Source→test dependency map** — any file with hits during a test is a dependency of that test.
     2. **Code coverage data** — feeds directly into the future coverage feature.
   - **On demand (heavy trace / Timeline):** step-by-step execution + variable capture. Only runs when user opens the Timeline for a specific test. That test is re-run with full instrumentation. Future feature — not built now.

2. **Priority: features first, framework expansion later.** Ship timeline debugger and code coverage polished on Jest before tackling Vitest/Mocha/Playwright. The framework-agnostic architecture notes below are forward-looking, not a priority.

3. **Scale tiers matter.** Optimizations should degrade gracefully:
   - **Small projects (<200 test files):** Current approach is fine, trace everything upfront (light trace).
   - **Medium projects (200–2k):** Batch aggressively, cache across sessions.
   - **Large projects (2k–10k+):** Hybrid eager/lazy, persistent cache, prioritize visible files.

---

## Improvement 1: Batch Jest Invocations + Light Trace (HIGH IMPACT — START HERE)

### Problem A — Process Startup Overhead

`_runFiles` and `SessionTraceRunner.runFile()` both spawn a **separate Jest process per test file** (up to `CONCURRENCY`). Each Jest process has ~500ms–1s startup overhead (Node boot, config loading, transform cache init). For 5k files, that's 5k process spawns.

### Problem B — Heavy Trace Writes

The current trace runtime emits `__strace.step` at every statement + `__strace.var` for shared variables. For 20k tests this can produce GB-scale JSONL. 99% of this data is never looked at — the user only opens the timeline for a few tests.

### Solution — Two Changes in One Improvement

#### A. Batch files per Jest process

```
Before:
  File queue: [a.test.ts, b.test.ts, c.test.ts, d.test.ts, ...]
  → jest a.test.ts  (process 1)
  → jest b.test.ts  (process 2)
  → jest c.test.ts  (process 3)  ... up to CONCURRENCY

After:
  File queue: [a.test.ts, b.test.ts, c.test.ts, d.test.ts, ...]
  → jest a.test.ts b.test.ts c.test.ts ... d.test.ts  (batch of N files per process)
  → Stream per-file results via --json / custom reporter
```

- **Batch size heuristic:** `BATCH_SIZE = Math.max(5, Math.min(50, totalFiles / CONCURRENCY))`
- Per-file result streaming preserves current progressive UX (results appear as each file completes within the batch).
- **AST transform still runs inside each Jest process** — nothing about per-test data collection changes. Batching is purely about process overhead.

#### B. Light trace mode (default) — line hits only

Comment out / gate the heavy trace writes. The transform emits exactly one thing per executed statement:

```
__strace.hit(testId, fileId, lineNumber)
```

The runtime accumulates these into an in-memory structure per test:

```
testHits: Map<testId, Map<filename, Set<lineNumber>>>
```

Written to disk once per test at test end — not streamed per statement. One compact record per test.

**This single structure does double duty:**

1. **Source→test dependency map** — the keys of the inner map (filenames) are the files that test depends on. Drives on-save reruns.
2. **Code coverage data** — the line number sets feed the future coverage feature directly.

No separate import tracking. No step order. No variables. No call stacks. Anything beyond "line was hit" is Timeline territory and waits until that feature lands.

**Heavy trace (step order + variables) is deferred entirely:**
- Timeline feature is not being built now.
- When it is built: user opens Timeline for a specific test → extension re-runs just that one test with full instrumentation → caches per-test timeline data → light trace stays light for everyone else.

### Implementation Notes

- `SessionManager._runFiles()`: shift `BATCH_SIZE` files from the queue per process invocation.
- Jest accepts multiple positional args: `jest pathA pathB pathC`.
- Set **`--maxWorkers=1`** on each Jest process — we handle parallelism at the outer level (batch count × CONCURRENCY). Avoid nested parallelism.
- With light trace, the per-process output is small: one hit-map record per test, written at test end. Partitioning by file/test is trivial.
- Custom reporter (or `--json`) emits per-file events as each completes in the batch.

### Failure Isolation

- `--no-bail` + `--forceExit` already in place — a single crashing test shouldn't tank the batch.
- **Crash/OOM fallback:** if a batch process dies, split that batch in half and retry. Escalate to single-file runs only if a specific file repeatedly crashes.

### Storage Impact (Light Trace)

| Scenario | Heavy trace (current) | Light trace (proposed) |
|---|---|---|
| 10k files × 20k tests | GB-scale JSONL | A few MB JSONL total |
| Timeline open for 1 test | — | One small per-test trace file (re-run that test) |

### Combined Impact

- **30–50% reduction in total run time** from batching alone.
- **~100x reduction in trace storage** from light-trace default.
- **Scales to 10k+ test files** without burning storage or CPU.

---

## Improvement 2: Persistent Dependency Cache (With Rotation)

### Problem

Every VS Code session starts fresh. The trace store, `sourceToTests`, and `coverageIndex` are in-memory. A 5k-test project re-runs everything just to rebuild the dependency map on every restart.

### Storage Location

- **Extension-owned cache directory** (not project-owned — don't pollute user's repo).
- Use VS Code's `context.globalStorageUri` as the root:
  `~/Library/Application Support/Code/User/globalStorage/<publisher>.<extension>/cache/`
- One subdirectory per cached project, named by project key (below).

### Project Keying

Workspace absolute path is unreliable (users rename/move folders). Instead:

```
projectKey = sha256(
  normalize(package.json content) +
  normalize(jest.config.* content) +
  workspace name
)
```

Fallback to workspace folder path if config files are missing.

### Cache Contents (per project)

```
<cacheRoot>/<projectKey>/
  manifest.json           — version, createdAt, lastUsedAt, sizeBytes
  source-to-tests.json    — the dependency map
  trace-index.json        — pointers to any on-demand timeline traces
  discovery-cache.json    — discovery results per test file (improvement 3)
```

### Staleness — Per-Entry mtime Validation

On load, for each cached file entry:
1. Check file still exists (handles deletions even across IDEs).
2. Compare stored `mtime` to current filesystem `mtime` from `fs.stat`.
3. If missing or changed → drop that entry; re-trace that file lazily.

`mtime` = last-modified timestamp on the file system. This approach is **resilient to multi-IDE usage**: if the user edits a source file in another IDE without this extension, the mtime changes, we detect it on next load, and we re-trace. Worst case is over-invalidation (safe, just slower first time).

### Rotation / Size Management — Extension-Managed

The extension owns its cache folder and prunes it so the user never needs to worry about disk bloat.

**Rules:**

| Rule | Value | Notes |
|---|---|---|
| Max cached projects | **10** | LRU evict oldest by `lastUsedAt` when an 11th appears |
| Per-project soft limit | **500 MB** | **Only enforced when >1 project is cached.** Single-project users never lose their cache |
| Total cap across projects | **~500 MB** (adjustable) | Only applies when >1 project |
| On eviction | Delete entire project subdirectory | Next session re-traces that project from scratch |

**Why single-project is unlimited:** if a user only works on one big project, their cache is always the "useful" one. Capping it would only hurt them. The size limits exist to stop one huge abandoned project from squatting on disk while active projects need space.

### User-Facing Commands

Two commands (the current project needs special handling because wiping its cache must also reset in-memory state):

**`Live Test Runner: Clear Cache (Current Project)`**

1. Delete the current project's cache subdirectory.
2. Reset in-memory state: dependency map, discovery tree, test results, coverage data.
3. Show notification toast: *"Cache cleared. Rerun tests to rebuild."* with a `Rerun Tests` action button.

**`Live Test Runner: Clear All Caches`**

1. Wipe the entire extension cache directory on disk.
2. For other cached projects: they'll simply re-trace next time they're opened — nothing to do now.
3. For the current project: same reset + toast as the single-project command above.

**Why the in-memory reset matters:** if cache files are deleted but in-memory state remains, the UI still shows test results, CodeLens counts, coverage marks, etc. — but there's no backing cache, and the user can't tell. A save or reload would then trigger a confusing re-trace with partial state. Resetting in-memory and prompting a rerun keeps the user's mental model accurate.

Optional nice-to-have: status bar "cache: X projects, Y MB" on hover.

### Impact

- Cold start goes from "trace 5k files" to "check 5k mtimes + trace ~50 changed files."
- Session restarts become near-instant for projects with stable dependencies.
- Extension's disk usage is bounded and predictable.

---

## Improvement 3: Persistent Discovery Cache

### Problem

Initial discovery parses every test file with Babel (40+ plugins). For 5k files this is CPU-heavy on startup.

### Solution

- Same cache directory and keying as Improvement 2 (`discovery-cache.json` alongside `source-to-tests.json`).
- Per-file: cache the test tree + shared-var info keyed by file path + mtime.
- On startup, only re-parse files with changed mtime.

### Relationship to Improvement 2

Both use the same cache directory, project key, and mtime validation logic. They can be implemented independently (different files on disk) but should share the validation/rotation code.

### Multi-IDE Safety

Same as Improvement 2 — mtime change on any edit (regardless of which IDE did it) triggers re-parse of that file. Safe.

### Impact

- Startup discovery drops from "parse 5k files" to "stat 5k files + parse ~20 changed files."

---

## Improvement 4: Prioritize Visible/Active Files

### Problem

All files are treated equally in the queue. User waits for file #4,327 to finish before seeing results for the file they have open.

### Solution

- On session start, query `vscode.window.visibleTextEditors` for open test files.
- Push these to the **front** of the run queue and trace queue.
- When user opens a new file mid-run, promote it in the queue.

### Impact

- Perceived performance improves dramatically — the user sees results for their current file in seconds, even if the full suite takes minutes.

---

## Improvement 5: Smarter Trace Scheduling (Hybrid Eager/Lazy)

### Problem

For extremely large projects (5k+), even batched eager tracing with light-trace is expensive. But we need the dependency map for instant on-save reruns.

### Solution — Tiered Strategy

| Project Size | Strategy |
|---|---|
| < 200 files | Eager trace all (batched + light trace) |
| 200–2k files | Eager trace all, batched + cached |
| 2k+ files | **Hybrid:** Eager trace open/recent files. Lazy trace on first save. `--findRelatedTests` as fallback. |

**Hybrid flow for large projects:**

```
Session start:
  1. Load persistent cache (most entries still valid)
  2. Eager trace: open editor files + recently edited files (git diff --name-only HEAD~20)
  3. Background: trace remaining invalidated files at low priority

User saves source.ts:
  1. Cache hit? → run affected tests (instant)
  2. Cache miss? → jest --findRelatedTests (fast, ~2s)
                   → background: trace those test files
                   → update persistent cache for next time
```

### Impact

- Large projects: upfront trace cost drops from O(N) to O(recently-changed).
- First save of untouched files has ~2s delay (findRelatedTests), then subsequent saves are instant.

---

## Improvement 6: Lighter Discovery Parser (Long-term)

### Problem

Full Babel parse with 40+ plugins is overkill for most discovery (just finding `describe`/`it`/`test` calls).

### Consideration

The full AST is needed for:
- Shared variable detection (`let`/`var` at describe scope)
- Dynamic test name detection
- Accurate line numbers for CodeLens

### Possible Approach — Two-Pass Discovery

1. **Fast pass (regex/tree-sitter):** Extract test names and line numbers. Covers 95% of files.
2. **Full pass (Babel):** Only for files with complex patterns (shared vars, dynamic names, `.each`).

### When to Pursue

- When adding Vitest/Mocha/Playwright support — the regex/tree-sitter approach generalizes across frameworks better than framework-specific Babel transforms.
- The current Babel approach is correct and well-tested for Jest. Don't rewrite it unless multi-framework is the next priority.

---

## Long-Term: Multi-Framework Architecture (Deferred)

**Priority note:** Features first (timeline debugger polish, code coverage), then framework expansion. This section is forward-looking reference — not on the near-term roadmap.

### What to Keep Framework-Agnostic

- **Discovery parser** — each framework has its own test syntax, but the output (test tree with names, lines, suites) is universal.
- **Trace runtime** (`__strace.hit` for light trace; `__strace.step`/`__strace.var` etc. when Timeline ships) — the runtime protocol is framework-independent. Only the injection mechanism (transform) changes.
- **Trace store and dependency mapping** — `sourceFile → testFile → tests` works for any framework.
- **Timeline debugger** — consumes the universal trace format regardless of source framework.
- **Persistent cache (Improvements 2 & 3)** — cache keying and rotation are framework-agnostic.

### What Needs Per-Framework Adapters

| Component | Jest | Vitest | Mocha | Playwright |
|---|---|---|---|---|
| **Transform injection** | Jest transform config | Vite plugin | Require hook / loader | Playwright transform |
| **Test runner invocation** | `jest --json` | `vitest --reporter=json` | `mocha --reporter json` | `playwright test --reporter=json` |
| **Result parsing** | Jest JSON format | Vitest JSON format | Mocha JSON format | Playwright JSON format |
| **Config detection** | `jest.config.*` | `vitest.config.*` | `.mocharc.*` | `playwright.config.*` |

### Why Custom AST Over Framework-Native Coverage

Framework-native coverage (V8 or Istanbul) gives you:
- Line/branch/function hit counts per file
- File-level "which files were touched"

It does **NOT** give you:
- Execution order (which line ran when)
- Variable values at each step
- Per-test attribution (which test touched which line)
- Hook vs test context separation

The timeline debugger, shared-variable detection, and precise per-test dependency mapping all require the custom instrumentation. Framework coverage is a useful **supplement** (cheap file-level mapping) but not a **replacement**.

---

## Implementation Priority

| # | Improvement | Effort | Impact | Dependencies |
|---|---|---|---|---|
| **1** | Batch Jest + Light trace | Medium-High | Very High (speed + storage) | None — start here |
| **2** | Persistent cache + rotation | Medium | High (instant restarts) | None |
| **3** | Persistent discovery cache | Low | Medium (fast startup) | Shares infra with #2 |
| **4** | Prioritize visible files | Low | Medium (perceived perf) | None |
| **5** | Hybrid eager/lazy tracing | Medium | High (for 2k+ projects) | #2 (needs persistent cache) |
| **6** | Lighter discovery parser | High | Medium | Multi-framework work |

**Recommended start:** Improvement #1, then #2 and #3 in parallel.

---

## Success Metrics

| Metric | Current (5k files, est.) | Target |
|---|---|---|
| Initial test run | ~25–40 min | ~10–15 min |
| Initial trace run (light) | ~25–40 min (heavy) | ~10–15 min (first), <30s (cached restart) |
| Trace storage (10k × 20k tests) | GB-scale | Few MB |
| Test discovery | ~30–60s | <5s (cached), ~30–60s (first) |
| On-save rerun latency | <1s (if traced) | <1s (cached), <3s (fallback) |
| Timeline data | Always captured (wasteful) | Captured on demand per test |
| Extension disk usage | Unbounded | ≤500 MB across up to 10 projects |
