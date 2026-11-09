# Test Explorer and editor: requirements

What the feature must do, and how we check it does. For the plain-language description see [Test Explorer and editor](../features/test-explorer.md); for how it is built see [the design](../development/design/test-explorer.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| E1 | List every test file, suite and test before any test runs, without running the framework's tests | `pytest-full-run`, `mixed-js-python`; unit: `testDiscovery`, `pythonDiscovery` |
| E2 | Support any nesting depth of `describe` blocks and classes | unit: `testDiscovery`, `resultStore` |
| E3 | Show dynamic tests (`test.each`, template-literal names, `parametrize`) as a template that fills in with the real cases after a run, and keep the template when it has no cases | `basic-full-run`; unit: `testDiscovery`, `testNames` |
| E4 | Update the tree when a test file is created, changed or deleted | `basic-on-save` (deleting a test file lowers the total) |
| E5 | Cache the parsed tree per project, keyed by file modification time, and re-read only changed files | ⚠️ no test yet |
| E6 | Add the files the framework's config runs even when no `testFilePatterns` pattern matches, and show files the framework never runs as excluded, not as failed or running | `basic-full-run` |
| E7 | Show skipped and `todo` tests as skipped, each with its own icon (a todo is not drawn like a skipped test, a skipped test not like one never run) | `basic-full-run`, `vitest-full-run`; unit: `resultStore` |
| E8 | Show a status icon in the gutter and the duration after each test line, coloured by `durationThresholds` | unit: `duration` |
| E9 | Offer `▶ Run`, `▷ Debug` and `◈ Results` above each test and group; `▶ Run` runs exactly that scope, with or without a session | `basic-scoped-run`, `vitest-scoped-run`, `pytest-scoped-run` |
| E10 | Show Total, Passed, Failed and, only while tests run, Running; filter the tree by a card or the status dropdown | `basic-running-count`; unit: `statusFilter` |
| E11 | Keep the summary total equal to the number of tests in the tree | `basic-full-run`; unit: `resultStore` |
| E12 | Use the framework's own line numbers for a test once it has run | ⚠️ no test yet |
| E13 | Show a failed test's message after the line where it failed (in the test, and the source line it was thrown from), for Jest, Vitest and pytest; the hover has the whole message, Show diff (when both values are known), Open in Results and Dismiss | `failure-on-line`, `vitest-full-run`, `pytest-full-run`; unit: `failureInfo` |
| E14 | Hide a failure message on a line edited since the run, and a dismissed one until its test runs again; `showFailuresInEditor` turns them off | `failure-on-line` |

⚠️ marks a requirement no automated test checks yet.

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | Discovery never blocks the editor: files are parsed in small batches with a yield between them. |
| Q2 | Reopening a project with a warm cache only checks file times; it doesn't parse unchanged files. |

## Out of scope

- Finding tests whose names exist only at runtime (a loop that builds `it()` calls from data) before they run. They appear after the first run.
