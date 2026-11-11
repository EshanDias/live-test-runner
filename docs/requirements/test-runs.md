# Test runs: requirements

What the feature must do, and how we check it does. For the plain-language description see [Test runs](../features/test-runs.md); for how it is built see [the design](../development/design/test-runs.md). The [project-wide requirements](project-rules.md) apply too, above all G2 (never touch the project), G3 (same results as the user's own runs), G4 (the resource budget) and G5 (nothing before Start, nothing after Stop).

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| T1 | Give the same result for every test as the framework's own run of the project | `vitest-full-run`, `pytest-full-run`, `cra-app`, the real-repo matrix |
| T2 | Run the test files open in the editor first, and move a test file opened during the run to the front | `basic-open-first`; unit: `batchQueue` |
| T3 | Show a file as running only once the framework starts it, and its result as soon as it ends | `vitest-batch`, `basic-full-run` |
| T4 | Run batches in parallel within the budget; pytest one process at a time | unit: `batchQueue`, `resources` |
| T5 | Stop a test that runs longer than `hangTimeoutSeconds`, fail its file with the reason, and finish the other files | `basic-hang`, `vitest-hang`, `pytest-hang` |
| T6 | Retry the files of a crashed batch in smaller batches, then on their own with a plain run; log a warning | ⚠️ no test yet (scenarios only check that no fallback runs when none is needed) |
| T7 | Retry a batch once when a file vanished while the framework scanned the project (tests that create and delete files) | unit: `vanishedFile` |
| T8 | On Stop, end every framework process and its children; start no retry, fallback or queued batch; leave nothing spinning | `basic-stop`, `vitest-stop`, `pytest-stop`, `mixed-stop` |
| T9 | Announce "finished" once, after the last run in flight; progress never above 100% | `basic-full-run`, `basic-save-during-run` |
| T10 | Run the project's own framework with its config, setup files and test-script flags (`--config`, `--resetMocks`, Node options) | `basic-full-run`, `esm-fn-config`, `ts-config`, `jest-svelte-esm` |
| T11 | Pass names to the framework intact: spaces, `^`, `\|`, `&` | `basic-scoped-run` |
| T12 | Keep caches outside the project; Clear Cache deletes a project's data; delete data unused for 30 days | `basic-clear-restart`, `commands`; unit: `storage` |
| T14 | Angular 21+ (Vitest through Angular's unit-test builder): detected from `angular.json` (not run as plain Vitest), each Angular project run with `ng test <name>`; results with line numbers, per-test output, coverage with the project's provider, a single test by name, Update snapshot; nothing written into the project (Angular's build cache off, coverage in the session folder); Karma projects get a clear message | `angular-full-run`, `angular-debug`, `angular-snapshot-update`; unit: `angularRunner`, `frameworkRegistry` |
| T15 | Angular saves: rerun the test files that import the saved file (relative imports), a template's component tests, else every test of its project | `angular-full-run`; unit: `jsImporters` |
| T13 | Without the framework installed, or with an environment that can't run it, run nothing, mark nothing failed, and say how to fix it | `pytest-no-pytest` |
| T16 | Vitest batches together use at most half the cores: each gets `--maxWorkers` from the shared budget, a lower limit in the project's config is kept, and `--minWorkers=1` is added below Vitest 4 only | unit: `resources`, `vitestRunnerArgs`; e2e: `vitest-full-run`, `vitest-batch` (real Vitest accepts the flags) |
| T17 | Compile a source file once, not once per batch: every batch and later session of a project reuses the framework's compiled files (Jest: one generated config per config text, so one transform cache and file map); a changed config or extension never reuses stale output | unit: `stableJestConfig`; e2e: `basic-full-run` (several batches, one cache) |
| T18 | When the framework's list of runnable files is not remembered from the last session, start the test files on screen while the list is made (single-framework projects, budget of two or more processes); a file the list leaves out loses its results, coverage and trace and shows as not run | `pytest-open-first-while-listing`, `basic-open-first` |

⚠️ marks a requirement no automated test checks yet.

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | The framework always runs in a child process, never inside VS Code's extension host. |
| Q2 | Processes are spawned (streamed), never `exec`'d (buffered and truncated). |
| Q3 | Every run writes one INFO summary line: what started it, how many files and tests, how long. |

## Out of scope

- Running tests on another machine or in a container.
