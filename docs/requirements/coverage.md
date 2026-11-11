# Coverage: requirements

What the feature must do, and how we check it does. For the plain-language description see [Coverage](../features/coverage.md); for how it is built see [the design](../development/design/coverage.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| C1 | Measure coverage during normal runs, with no extra run or command | `vitest-coverage`, `pytest-coverage`, `basic-full-run` |
| C2 | Mark each executable line covered, partial (a branch missed) or uncovered, on every line of a statement that spans several lines | `coverage-editing`; unit: `statementLines` |
| C3 | Count files no test loads as 0%, so totals match the framework's own report | `vitest-coverage`, `pytest-coverage` (totals equal coverage.py's report) |
| C4 | Follow the project's coverage settings (Jest `collectCoverageFrom`, Vitest `coverage.include` / `exclude`, coverage.py's config), plus `coverageExclude` | `pytest-coverage`; unit: `coverageScope` |
| C5 | List the tests that ran a line in the hover, with their status, and the missed branches; a test file's rerun replaces its entries (a deleted test leaves the list) | `vitest-trace`, `pytest-related`, `jest-vue`; unit: `traceRecords` |
| C6 | Move bars with their lines while the file is edited; give an edited or new line no bar until it is measured again; keep bars through formatting | `coverage-editing`; unit: `lineMatch` |
| C7 | Tint a saved file until its rerun ends, then clear the tint whatever the outcome | `coverage-editing` |
| C8 | Hide and show bars and hover with `showCoverageInEditor` / the eye button | `coverage-editing` |
| C9 | Without a coverage package, still run the tests and say in the Coverage tab what to install | `pytest-no-coverage`; unit: `coverageOff` |
| C10 | Merge a file's coverage by line when Jest and Vitest both test it | unit: `coverageMerge` |
| C11 | Map coverage of compiled files (TypeScript, Vue, Svelte, Astro, Marko) back to their source lines | `ts-config`, `jest-vue`, `jest-svelte-esm`, `vitest-components` |
| C12 | Write no coverage files into the project | `vitest-coverage`, `pytest-coverage` |
| C13 | Equal what a fresh full run would report now: a test file's rerun **replaces** its coverage, so a removed test, a test file that reaches less, or code that stops calling a file lowers it | `coverage-live`; unit: `coverageContributions` |
| C14 | Remove a deleted test file's coverage, and a deleted or renamed source file from the totals | `coverage-live`; unit: `coverageContributions`, `traceRecords` |
| C15 | Count a source file created during the session (0% while no test loads it) and recount an edited one, by the same rules as the scan at Start | `coverage-live` |
| C16 | After a save, rerun in full, once nothing else runs, the test files whose coverage predates the change (single tests rerun by name and related runs measure nothing); replace their results too; only in a session, stopped by Stop, once per change | `coverage-live`, `basic-on-save` |
| C17 | Say **Updating coverage (N files)…** and grey the totals while any file waits for that rerun; say how many test files ran without coverage (fallback runs) | unit: `coverageContributions` ⚠️ no e2e of the webview text |
| C18 | Measure per test file on every framework: Jest records per test file; Vitest and Angular through a wrapper of the project's own provider; pytest from its per-test contexts, crediting import-time lines to each importing test file | `coverage-live` (Jest) ⚠️ Vitest, Angular, pytest e2e pending; plugin: `test_coverage_is_written_per_test_file` |

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | Coverage maps are read from disk when a file is drawn, not kept in memory for the whole project. |
| Q2 | Redrawing while typing waits 150 ms after the last keystroke. |
| Q3 | Measuring never changes what the code does: instrumented code gives the same results as the original, including strict mode (`"use strict"`), `this` in methods called through `?.`, and the line numbers in stack traces (unit: `jestTraceTransform`; e2e `failure-on-line`). |

## Out of scope

- Coverage reports in HTML or other formats. The framework's own command still makes them.
