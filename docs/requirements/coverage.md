# Coverage: requirements

What the feature must do, and how we check it does. For the plain-language description see [Coverage](../features/coverage.md); for how it is built see [the design](../development/design/coverage.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| C1 | Measure coverage during normal runs, with no extra run or command | `vitest-coverage`, `pytest-coverage`, `basic-full-run` |
| C2 | Mark each executable line covered, partial (a branch missed) or uncovered, on every line of a statement that spans several lines | `coverage-editing`; unit: `statementLines` |
| C3 | Count files no test loads as 0%, so totals match the framework's own report | `vitest-coverage`, `pytest-coverage` (totals equal coverage.py's report) |
| C4 | Follow the project's coverage settings (Jest `collectCoverageFrom`, Vitest `coverage.include` / `exclude`, coverage.py's config), plus `coverageExclude` | `pytest-coverage`; unit: `coverageScope` |
| C5 | List the tests that ran a line in the hover, with their status, and the missed branches | `vitest-trace`, `pytest-related`, `jest-vue` |
| C6 | Move bars with their lines while the file is edited; give an edited or new line no bar until it is measured again; keep bars through formatting | `coverage-editing`; unit: `lineMatch` |
| C7 | Tint a saved file until its rerun ends, then clear the tint whatever the outcome | `coverage-editing` |
| C8 | Hide and show bars and hover with `showCoverageInEditor` / the eye button | `coverage-editing` |
| C9 | Without a coverage package, still run the tests and say in the Coverage tab what to install | `pytest-no-coverage`; unit: `coverageOff` |
| C10 | Merge a file's coverage by line when Jest and Vitest both test it | unit: `coverageMerge` |
| C11 | Map coverage of compiled files (TypeScript, Vue, Svelte, Astro, Marko) back to their source lines | `ts-config`, `jest-vue`, `jest-svelte-esm`, `vitest-components` |
| C12 | Write no coverage files into the project | `vitest-coverage`, `pytest-coverage` |

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | Coverage maps are read from disk when a file is drawn, not kept in memory for the whole project. |
| Q2 | Redrawing while typing waits 150 ms after the last keystroke. |
| Q3 | Measuring never changes what the code does: instrumented code gives the same results as the original, including strict mode (`"use strict"`) and `this` in methods called through `?.` (unit: `jestTraceTransform`). |

## Out of scope

- Coverage reports in HTML or other formats. The framework's own command still makes them.
