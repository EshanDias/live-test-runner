# Master tracker — everything open, in one list

Created 2026-11-06 (owner asked to combine the 3.3.0 tracker, the pytest / Vitest / coverage / performance plans, the bug list and new ideas).
Sources were read on 2026-11-06 against `main` @ v3.2.1. "Verify" = the plan says one thing, I did not confirm it in the code yet (task A1 does that).

Status: ⬜ not started · 🔄 in progress · ✅ done · ⏸ parked · ❓ verify
**Pick** column: owner marks what goes next (1, 2, 3 …).

**Current release: 3.3.0 (owner, 2026-11-07)** — finish what was started before anything new: the open pytest work (C1, C4, then A2 because C2 needs it, then C2). Timeline (C3 / C5 / C9) stays out. Frameworks (B) and D items come after.

**Status 2026-11-07:** C4, C1, A2, C2 done — all open pytest work except the Timeline. Branch chain (pushed, no PRs): `feat/master-tracker` → `feat/pytest-monorepos` → `feat/framework-router-n` → `feat/pytest-mixed-js`. Full unit + e2e green on each (P7: 57/57, P8 incl. A2: 59/59). Same day, owner's follow-ups: C20 fixed (`bugfix/save-rerun-stuck-running`, off `feat/pytest-mixed-js`), C21 + C22 verified (`feat/pytest-workspace-checks`, off the bugfix branch). Owner then asked for the cleanup inside 3.3.0: C19, C18, C16 #4, A4, A1, BUG-44 and C23 (restart loop) done; BUG-43 open; E2 left to the owner. Release prep `feat/release-prep-3.3.0` (version 3.3.0, changelogs dated) → PR to `release/3.3.0`; full e2e 63/63 (cra-app + disk-changes rerun after the Mac slept mid-suite), real repos jest (BUG-43 only) / unplugin / slidev / vueuse pass.

Owner rules for new work (2026-11-06): a framework ships with **results and coverage together**; correctness before speed; one framework after the other; **Angular first**. See also `3.3.0-features.md` (detail for the original five items; item 1 is done) and `CLAUDE.md`.

---

## A. Foundation (do before or beside new frameworks)

| ID | Item | Status | Size | Pick | Notes |
|---|---|---|---|---|---|
| A1 | **Gap audit** (2026-11-07) | ✅ | 1 d | | Plans: no unticked items; `3.3.0-features.md` open rows = B/D here. Feature matrix in sync (`framework-matrix.js --check`). Docs vs code: 3 settings missing from the guide (`hangTimeoutSeconds`, `coverageExclude`, `testFilePatterns`) — added; every command documented (some in combined rows). Found and fixed on the way: C19 (dead coverage map, CLAUDE.md described it as live), C18 (multi-line bars), A4 (coverage-off note). Stale suspects I1 / H1 do not exist; A3 waits for Mocha (B3). |
| A2 | **Router for N frameworks.** Confirmed in code (2026-11-06): `RoutedFramework = 'jest' \| 'vitest'` (`allowedFrameworks.ts`, 28 uses), the router's factories and the `frameworks` setting enum are the same. pytest plan task 1.5 is ticked but this part was not done; pytest only works because `ProjectContext` gives it a single-framework provider. | ✅ | 2 d | 3 | Needed by Playwright / Cypress mixes (Vitest + Playwright is the common case), Mocha next to Jest, and pytest P8. Do once, here. **Done 2026-11-07** on `feat/framework-router-n`: `ROUTED_FRAMEWORKS`, `projectFrameworks().frameworks`, router with a factory per framework; pytest uses it. Adding Playwright / Mocha = an id + a factory + a marker. |
| A3 | Generic **results-and-coverage batch runner** shared by Mocha / node:test / Playwright / Cypress (one class, per-framework runner + reporter) | ⬜ | 3 d | | Built with the first consumer (Mocha), not alone. |
| A4 | Capability-driven UI: a feature a framework lacks is hidden or says why | ✅ | 1 d | | `feat/capability-ui`. Audit: ▶ Run / ▷ Debug work for all three; covering tests already say why (hover); Timeline refuses with a message (dormant, C9 — its button left alone). Gap fixed: Coverage tab said nothing when coverage was off → `FrameworkServices.coverageOffReason` + `CoverageTotals.off` note. e2e `pytest-no-coverage` |

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
| C2 | **pytest P8 — JS + Python in one folder** (`LanguageRouter`, mixed status bar, Explorer groups) | ✅ | 5 d | 4 | phase 8; needs A2. **Done 2026-11-07** on `feat/pytest-mixed-js`: one project runs both, saves wake only their language, no Python → JS still runs, `backend/` subfolders found. |
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
| C16 | Performance plan leftovers (the plan file was removed 2026-11-06; its #1 batch runs, #2 transform cache and #3 discovery cache are shipped). **#4 Prioritise visible files — ✅ done 2026-11-07 (`feat/run-open-files-first`):** on Start put the open test files (`visibleTextEditors`) at the front of the run queue, promote a file opened mid-run. **#5 Hybrid trace for 2k+ files:** trace only open / recently changed files eagerly, the rest lazily on first save (related run as fallback). **#6 Lighter discovery parser:** fast regex / tree-sitter pass, Babel only for files with shared vars, dynamic names or `.each`. | 🟡 #4 done, #5 / #6 open | #4: 1–2 d | | Search found none of the three in the session code. Measure on a large project first; #4 is cheap and the most visible. |
| C17 | **BUG-43** jest-runtime tests fail under the session run (jest monorepo) — open; **BUG-44** concurrent batches race with tests writing into the project — ✅ fixed (retry once when the file Jest failed on vanished, `bugfix/jest-crawl-retry`) | 🟡 BUG-44 done, BUG-43 open | ? | | `docs/bugs-and-issues.md`. BUG-43 next step: run one `runtime_*.test.js` through the session config and compare with plain Jest (only Jest's own tests that build inner Runtimes) |
| C18 | Multi-line statements had a coverage bar on their first line only (confirmed). **Fixed** without the trace: `coverage/statementLines.ts` (a statement with nothing inside marks every line it spans); `trace-driven-decorations.md` removed | ✅ | 1 d | | `feat/cleanup-small`; e2e `coverage-editing` |
| C19 | Core `CoverageMap`: was dead (always empty; nothing reran by it). **Removed** with `SelectionPolicy`, `TestSession.start` / `getCoverageMap`, `IFrameworkAdapter.getAffectedTests`; docs updated | ✅ | 1 d | | `feat/cleanup-coverage-map` |
| C20 | **Real-repo `repo-vitest` failed on unplugin, slidev, vueuse** (found 2026-11-07, same on `main` @ v3.2.1): after a source save, `…nothing left running` saw 2–18 tests `running`. Two causes: (1) the scenario restored its edited test file by writing it on disk — an outside change, so a queued rerun started right before the check (scenario now restores through the editor and waits); (2) product: files the tests write (`output.js`, `main.js`) each started a `vitest related` run that found nothing (11 extra processes on unplugin) — a queued disk change the last run's trace knows no test of is now dropped (`_unusedByLastRun`) | ✅ | 1 d | | `bugfix/save-rerun-stuck-running`; real repos unplugin / slidev / vueuse pass; e2e `disk-changes` + save scenarios pass |
| C21 | **Python monorepo without a shared `.venv`** (owner, 2026-11-07): services that each have their own `.venv` (no uv workspace) — each is a project and uses its own environment; a project's `.venv` comes before one above it (`venvRoots`) | ✅ | 0.5 d | | `feat/pytest-workspace-checks`; no product change; e2e `pytest-venv-per-service` on `fixture:monorepo-pytest-venvs` (tests assert `sys.prefix`) |
| C22 | **Front-end folder + pytest folder in one window** (owner, 2026-11-07): a multi-root workspace lists both in the switcher, each runs alone, saves wake only their project | ✅ | 0.5 d | | `feat/pytest-workspace-checks`; no product change; e2e `multi-root-js-python` (harness: `workspace` may be an array → `.code-workspace`) |
| C23 | **Session restarted forever on test suites that write many files** (found 2026-11-07 on the Jest monorepo, a 3.2.1 bug): >20 files written during a run → "restarting the session" → the run writes them again. Fixed: changes from our runs never restart (by queue, or by modified time when reported late), unrun test fixtures dropped, a disk restart never repeats for the same files | ✅ | 0.5 d | | `bugfix/jest-crawl-retry`; e2e `disk-changes` 5b; real repo `jest` |

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
| E2 | `bugs.md` (temp): not an empty file — the owner's own bug-workflow template (instructions + summary format, empty list). Kept; owner decides | ⏸ | | |
| E3 | Update docs per CLAUDE.md with each item (changelogs, README, guide, site, matrix via `scripts/framework-matrix.js`) | — | every item |

## F. What is already shipped (for the record, not to redo)

Jest, CRA, Vitest (results, output, live streaming, coverage, related, monorepos, mixed Jest + Vitest, trace / covering tests), **pytest phases 0–6 and 9** (run, output, failures, coverage, Debug, covering tests, related on save, interpreter picker) in 3.2.0; nested describe tree; discovery and transform caches; coverage bars (3.2.1); storage cleanup, external file changes, settings gear.
