# Master tracker — everything open, in one list

Created 2026-11-06 (owner asked to combine the 3.3.0 tracker, the pytest / Vitest / coverage / performance plans, the bug list and new ideas).
Sources were read on 2026-11-06 against `main` @ v3.2.1. "Verify" = the plan says one thing, I did not confirm it in the code yet (task A1 does that).

Status: ⬜ not started · 🔄 in progress · ✅ done · ⏸ parked · ❓ verify
**Pick** column: owner marks what goes next (1, 2, 3 …).

**Current release: 3.3.0 (owner, 2026-11-07)** — finish what was started before anything new: the open pytest work (C1, C4, then A2 because C2 needs it, then C2). Timeline (C3 / C5 / C9) stays out. Frameworks (B) and D items come after.

Owner rules for new work (2026-11-06): a framework ships with **results and coverage together**; correctness before speed; one framework after the other; **Angular first**. See also `3.3.0-features.md` (detail for the original five items; item 1 is done) and `CLAUDE.md`.

---

## A. Foundation (do before or beside new frameworks)

| ID | Item | Status | Size | Pick | Notes |
|---|---|---|---|---|---|
| A1 | **Gap audit** (read-only): plan checkboxes vs code vs docs vs feature matrix; produce a list of real gaps | ⬜ | 1 d | | Known suspects: A2, A3, I1, H1. Output goes into this file. |
| A2 | **Router for N frameworks.** Confirmed in code (2026-11-06): `RoutedFramework = 'jest' \| 'vitest'` (`allowedFrameworks.ts`, 28 uses), the router's factories and the `frameworks` setting enum are the same. pytest plan task 1.5 is ticked but this part was not done; pytest only works because `ProjectContext` gives it a single-framework provider. | 🔄 | 2 d | 3 | Needed by Playwright / Cypress mixes (Vitest + Playwright is the common case), Mocha next to Jest, and pytest P8. Do once, here. |
| A3 | Generic **results-and-coverage batch runner** shared by Mocha / node:test / Playwright / Cypress (one class, per-framework runner + reporter) | ⬜ | 3 d | | Built with the first consumer (Mocha), not alone. |
| A4 | Capability-driven UI: a feature a framework lacks is hidden or says why (coverage tab, covering-tests hover, ▷ Debug) | ⬜ | 1–2 d | | Confirmed: only `features.trace` is read in the UI (`extension.ts:314`, the covering-tests hover). Missing coverage for pytest is handled one-off (env chip text, `traceOffReason`). `FrameworkCapabilities.coverage` / `related` are not used by any view. Needs a generic path. |

## B. Frameworks (each ships with results **and** coverage, or says plainly what can't work)

| ID | Item | Status | Size | Pick | Notes |
|---|---|---|---|---|---|
| B1 | **Angular spike** on a fresh `ng new` (21+): does `vitest run` work, does the builder (`ng test`) take our reporter / a generated `runnerConfig`, what is written into the project (`.angular/cache`), time per run | ⬜ | 1–2 d | | Decides B2. Also check `jest-preset-angular` projects already work as Jest. Karma projects stay unsupported. |
| B2 | **Angular** results + coverage (Vitest coverage mapping already exists) via builder + generated runner config in the session folder | ⬜ | 4–8 d | | Per-test trace later (Angular's build is not a plain Vite one). |
| B3 | **Mocha** — results + coverage. Coverage options to spike: V8 coverage (`NODE_V8_COVERAGE`, works through any TypeScript tool) vs our Babel transform (exact parity, must chain after ts-node / tsx / swc). Covering tests second. | ⬜ | 15–20 d | | `.mocharc` `spec` merges with CLI files → generated temp config. Reporter reused by Cypress. |
| B4 | **node:test** — results + coverage | ⬜ | 10–15 d | | Reuses B3. Detect by `node --test` scripts and `node:test` imports. Node 22+ for full support. |
| B5 | **Playwright** — results; coverage only server-side (browser code can't be measured without touching the project); one process at a time, kill the whole process tree on Stop; output redirected to the session folder | ⬜ | 10–15 d | | Spike first. Start never runs e2e files; setting to rerun on save (default off). |
| B6 | **Cypress** — results; same coverage limits; file-level runs unless `@cypress/grep` is already there; ▷ Debug hidden | ⬜ | 10–15 d | | Last. Needs screenshots / videos redirected (rule 9). |
| B7 | Later candidates (research report): Bun test, Go, RSpec; Jasmine / Deno / AVA low value; JVM, .NET, Rust, PHPUnit skip | ⏸ | — | | Go is the best non-JS pick after pytest. |

## C. Open work from earlier plans

| ID | Item | Status | Size | Pick | Source / notes |
|---|---|---|---|---|---|
| C1 | **pytest P7 — Python monorepos** (uv workspaces, per-member interpreter) | ✅ | 5 d | 2 | `pytest-support-plan.md` phase 7. Done 2026-11-07 on `feat/pytest-monorepos` |
| C2 | **pytest P8 — JS + Python in one folder** (`LanguageRouter`, mixed status bar, Explorer groups) | ⬜ | 5 d | 4 | phase 8; needs A2 |
| C3 | pytest Timeline debugger | ⏸ | — | | D6, "later" |
| C4 | pytest plan document is stale: roadmap says 3.4 / 3.5 / 3.6, it all shipped as 3.2.0 | ✅ | 0.5 d | 1 | Done 2026-11-07: roadmap shows 3.2.0 shipped, phases 7–8 → 3.3.0 |
| C5 | **Vitest Timeline debugger** (phase 10: runner, step/variable capture on the Vite plugin, tests) | ⏸ | 8 d | | Plan file removed 2026-11-06 (all other phases shipped). Discussed together with C9 later |
| C6 | Vitest: v1.x / v2.x run with results only (no listing, related, trace, line numbers) | ⏸ | — | | By design; revisit if users ask |
| C7 | Vitest ADR-9 leftovers. Checked: `.test-d.ts` files ARE type-checked on a source save (`SessionManager._typecheckRelated`) and the v8 ignore-hint case is handled in `vitestTraceTransform.js` → both ✅. Not checked: Vitest 4 project root (the wrapper's comment says Vitest 4+ has no workspaces; no sign of a problem). Known limitation, by design: Vue templates under Jest are not counted. | ✅ | — | | Nothing to do unless a real project shows a problem |
| C8 | Editor squiggles (VS Code `Diagnostic`s at the failure line) — owner decided "not now" in the Vitest plan | ⏸ | 3 d | | Overlaps D2 (failure on the line). Decide together. |
| C9 | **Timeline debugger = dormant, Jest-only prototype (owner, 2026-11-06: never worked as expected, may be rewritten).** In code: `src/timeline/` (`JestInstrumentedRunner`, store, decorations, instrumentation) + webview `timelineView` / `timelineSidebar` / `PlaybackEngine` ≈ 2,500 lines. The command `liveTestRunner.openTimelineDebugger` is registered but needs file + test arguments that nothing in the UI passes; the ⏱ row button is `disabled` ("Coming Soon"); README says "coming soon". `FrameworkServices.instrumentedRunner` exists for it. | ⏸ | rewrite: large | **last** | **Owner decision (2026-11-06): the owner works on this personally to get the exact output wanted, and it is the last feature to give users.** Nobody starts it without the owner. Dormant code stays as reference. C3 and C5 (pytest / Vitest Timeline) wait for it. |
| C10 | Coverage T2 **DiffChecker** + function-level stale marking (today the whole file goes stale) | ⏸ | 5 d | | `code-coverage-plan.md` §9, §20. `DiffChecker.ts` stub (T6) does not exist. |
| C11 | Coverage T3 **sole-coverage warnings** (lines covered by one test only) | ⏸ | 3 d | | needs per-branch → test map |
| C12 | Coverage T4 coverage **trend** across sessions | ⏸ | 2 d | | §8.5, low priority |
| C13 | Coverage T8 **file detail page** (tests covering a file + uncovered functions / branches) | ⏸ | 4 d | | T7 index it needs is done |
| C14 | Coverage T10 **Problems panel** for coverage cliffs (opt-in) | ⏸ | 2 d | | only if users ask |
| C15 | Coverage via VS Code's own Testing API (`FileCoverage`) — option A from the bars decision | ⏸ | 3 d | | Start of "mirror into the Testing view" (D5 below) |
| C16 | Performance plan leftovers (the plan file was removed 2026-11-06; its #1 batch runs, #2 transform cache and #3 discovery cache are shipped). **#4 Prioritise visible files:** on Start put the open test files (`visibleTextEditors`) at the front of the run queue, promote a file opened mid-run. **#5 Hybrid trace for 2k+ files:** trace only open / recently changed files eagerly, the rest lazily on first save (related run as fallback). **#6 Lighter discovery parser:** fast regex / tree-sitter pass, Babel only for files with shared vars, dynamic names or `.each`. | ⬜ | #4: 1–2 d | | Search found none of the three in the session code. Measure on a large project first; #4 is cheap and the most visible. |
| C17 | **BUG-43** jest-runtime tests fail under the session run (jest monorepo); **BUG-44** concurrent batches race with tests writing into the project | ⬜ | ? | | `docs/bugs-and-issues.md` |
| C18 | `trace-driven-decorations.md` (green on every line a statement spans, from the trace). Checked: **not implemented** — `CoverageDecorationManager` uses the manifest + counters + `MeasuredLines`, never the trace store. The 3.2.1 rework solved a different problem (bars moving while editing). | ⬜ | 1–2 d | | Check on a real project whether a multi-line statement still gets a bar on its first line only; if it does, do this, else archive the plan. |
| C19 | Core `CoverageMap`: confirmed dead. `buildFromCoverage` expects a `coveredBy` field that Jest / Vitest coverage JSON never has, so the map is always empty; `RunnerBackedAdapter.getAffectedTests` and a comment in `SessionManager` still point at it. | ⬜ | 1 d | | Remove it (and the doc mentions) — the trace and `related` runs replaced it. |

## D. 3.3.0 features (original list + new)

| ID | Item | Status | Size | Pick | Notes |
|---|---|---|---|---|---|
| D1 | Coverage bars that stay out of the way | ✅ | | | shipped in 3.2.1 |
| D2 | **Failure message on the failing line + expected / actual diff** (hover: Show diff, Dismiss) | ⬜ | 4 d | | Basis for D3 |
| D3 | **Update snapshot** button for a failed snapshot test (Jest, Vitest; pytest with syrupy / pytest-snapshot later). Old branch `feat/add-jest-snapshot-support` (April 2026, 267 commits behind, old architecture) is reused as an idea only. Writes the user's snapshot files, so only on an explicit click, with a tooltip saying so; warn for inline snapshots when the editor has unsaved changes. | ⬜ | 2–3 d | | Pairs with D2 (same hover) |
| D4 | **Copy buttons**: today `opacity: 0` until hover, tiny `⎘` glyph. Plan: always visible at ~50 %, SVG icon 14–16 px, visible on keyboard focus; a toolbar per panel with **Copy all** and **Copy for AI** (failure + stack + test source + framework); right-click Copy; "Copy failing test names" | ⬜ | 2 d | | Prepares D6 |
| D5 | Mirror results into VS Code's Testing view (optional, off by default) — native "fix test failure", coverage toggle | ⏸ | 5 d | | Research report; see C15 |
| D6 | **AI-agent bridge** — Copilot language-model tools + MCP server (failing tests, a test's output, covering tests of a line, coverage of a file, run these tests) | ⬜ | 6 d | | Free for users |
| D7 | Other research ideas: inline values from last run, changes-only view, flaky history, targeted mutation testing | ⏸ | — | | `agent 3` report |

## E. Housekeeping

| ID | Item | Status | Notes |
|---|---|---|---|
| E1 | Stale remote branches: `feat/add-jest-snapshot-support` (delete once D3 is built), `feat/eshan/timeline` (reference for the Timeline rewrite, C9) | ⏸ | |
| E2 | `bugs.md` (temp) is an empty template — delete or reuse | ⬜ | |
| E3 | Update docs per CLAUDE.md with each item (changelogs, README, guide, site, matrix via `scripts/framework-matrix.js`) | — | every item |

## F. What is already shipped (for the record, not to redo)

Jest, CRA, Vitest (results, output, live streaming, coverage, related, monorepos, mixed Jest + Vitest, trace / covering tests), **pytest phases 0–6 and 9** (run, output, failures, coverage, Debug, covering tests, related on save, interpreter picker) in 3.2.0; nested describe tree; discovery and transform caches; coverage bars (3.2.1); storage cleanup, external file changes, settings gear.
