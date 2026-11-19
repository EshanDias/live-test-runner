# Results panel: requirements

What the feature must do, and how we check it does. For the plain-language description see [Results panel](../features/results-panel.md); for how it is built see [the design](../development/design/results-panel.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| R1 | Show the test list, the output and the errors of the selected file, suite or test | ⚠️ no test yet (the webview's content can't be read from the e2e tests) |
| R2 | Keep the selection the same in the sidebar and the panel, and jump to a test from `◈ Results` in the editor | `commands` (Focus Test in Results Panel) |
| R3 | Show only output the framework attributed to a scope. A scope that never ran on its own shows a placeholder, never its file's output (G7) | `basic-on-save`; unit: `resultStore` |
| R4 | With Vitest and pytest, give every test that ran exactly its own output, even when empty; give a suite its hooks' output, and a file all of it | `vitest-output`, `pytest-full-run` |
| R5 | With Jest, keep a file's full output when one of its tests reruns on its own | `basic-on-save` |
| R6 | Capture console output even when the project's config sets `verbose: true` | `basic-full-run` |
| R7 | Show each failure's message, expected / received diff and location; a failing `beforeAll`, or a file that fails before any test, shows its own error and fails the file | `vitest-full-run`, `pytest-full-run` |
| R8 | Filter output by level (log, info, warn, error) and offer a copy button per line | ⚠️ no test yet |
| R10 | Copy buttons that are always visible (dimmed until hovered or focused): per output line, per failure, **Copy all** for the output and the errors shown | ⚠️ no test yet (the webview's buttons; the texts are checked by R11) |
| R11 | **Copy for AI**: the failures shown with framework, test name, file and line, error, the test's source (up to the next test) and the lines it was thrown from, as Markdown; **Copy Failing Test Names**: `file › test` per failing test. Clipboard only | `failure-on-line`; unit: `copyText` |
| R12 | **✨ Fix with AI** in the Errors pane: the first failure shown goes to the AI chat, else to the clipboard (see [AI assistants](ai-assistants.md), A15); hidden when `liveTestRunner.ai.fixWithAI` is off | ⚠️ no test of the button itself (`ai-bridge*` cover the command) |
| R9 | Write each run's raw framework output to the Test Output channel, separated by run number | `vitest-output` (output reaches the channel) |

⚠️ marks a requirement no automated test checks yet.

## Quality requirements

| # | Requirement |
|---|---|
| Q1 | The panel stays responsive on large projects: a run sends the files that changed, not the whole tree. |
| Q2 | Output is read from the store when a scope is selected, never held twice. |

## Out of scope

- Per-test output for Jest without rerunning the test on its own. Jest doesn't say which test printed a line.
