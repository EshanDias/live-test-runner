# On-save reruns: requirements

What the feature must do, and how we check it does. For the plain-language description see [On-save reruns](../features/on-save-reruns.md); for how it is built see [the design](../development/design/on-save-reruns.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by (e2e scenario) |
|---|---|---|
| S1 | Rerun nothing on save until the user clicks Start, and nothing after Stop | `vitest-session`, `basic-stop` |
| S2 | When a **test file** is saved, rerun that file and show its new or removed tests | `basic-on-save`, `pytest-on-save` |
| S3 | When a **source file** is saved, rerun only the tests that executed a line of it during their last run | `basic-on-save`, `vitest-trace`, `pytest-related` |
| S4 | Rerun the whole test file instead of single tests when a `describe` block's tests share a variable (declared in the block or at file scope; not a `require`d module), because single tests could then give a different result | `coverage-live`; unit: `testDiscovery` |
| S5 | When no test has executed the saved source file yet, rerun the test files that import it (the framework's related search) | `vitest-related`, `pytest-related` |
| S6 | When a non-code file is used by code (an Angular `templateUrl`, a `?raw` import, a CSS module), rerun the tests of the code that uses it | `repo-components`, `vitest-components` |
| S7 | When a framework **config** is saved, restart the session: re-read the config, the list of test files and every result | `basic-config-save` |
| S8 | When a test file created after Start is saved, ask the framework whether it runs that file, and rerun it if so | `basic-on-save` |
| S9 | Wait `onSaveDebounceMs` (default 300 ms) after a save, and run once for several quick saves of the same file | ⚠️ no test yet |
| S10 | In a mixed project, rerun each framework's own dependent tests with that framework only | `mixed-on-save`, `mixed-js-python` |
| S11 | Treat files changed **outside the editor** (pull, branch switch, generator, a coding assistant writing to disk, closed or open in the editor) like saves while testing is on | `disk-changes`, `pytest-disk-changes` |
| S12 | Restart the session instead of rerunning file by file when more than 20 files change at once | `disk-changes` |
| S13 | Queue files that change while tests run, and rerun them once the run ends | `disk-changes`, `pytest-disk-changes`, `basic-save-during-run` |
| S14 | Never rerun forever because tests write files: a file that changes again during its own rerun, a written file no test uses, and many files written during a run start no further runs, and the log says so | `disk-changes` |
| S15 | Announce "finished" once, after the last overlapping run, with progress never above 100% | `basic-save-during-run`, `vitest-save-during-run` |
| S16 | Mark the saved file's coverage as stale until its tests have measured the new version (the rerun, or the coverage refresh after it) | `coverage-editing`, `coverage-live` |

⚠️ marks a requirement no automated test checks yet. Those are the first places to add one.

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | Target: a rerun of a few tests starts within a second of the debounce on a typical machine. Starting the framework is the main cost, not our own work. |
| Q2 | Parallel reruns stay within the machine's budget (G4). pytest runs one process at a time. |
| Q3 | Every rerun writes one INFO line to the Live Test Runner log: what started it and how many tests ran, or "no tests depend on this file". |

## Out of scope

- Rerunning while you type, before saving. Unsaved code is not what the test runner sees.
- Linking tests to files they only read as data (`fs.readFileSync` of a fixture).
