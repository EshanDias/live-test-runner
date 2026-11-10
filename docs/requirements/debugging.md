# Debugging: requirements

What the feature must do, and how we check it does. For the plain-language description see [Debugging](../features/debugging.md); for how it is built see [the design](../development/design/debugging.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| D1 | Start a debug session for exactly the chosen test, suite, class or `.each` / parametrized function | `basic-debug`, `vitest-debug`, `pytest-debug` |
| D2 | Build a launch config VS Code accepts and that runs on every OS: a JS entry point (not a shell shim), the project root as working folder, paths with spaces | `basic-debug` |
| D3 | Jest: run in band, without coverage; Create React App projects use their extracted Jest config | `basic-debug`, `cra-app` |
| D4 | Vitest: run Vitest's CLI one file at a time, with no test or hook timeouts, child processes attached | `vitest-debug` |
| D5 | pytest: use the Python Debugger with `-m pytest <node id>` and the project's own interpreter; without that extension, say what to install and start nothing | `pytest-debug` |
| D6 | Apply the test script's flags and Node options (`--config`, `--resetMocks`, Jest's ESM mode) | ⚠️ no test yet |
| D7 | Work with or without an active session | ⚠️ no test yet |
| D8 | Jest / Vitest: start the test directly, with its output in the Debug Console, not typed into the integrated terminal (a command typed while the user's shell is still starting is lost, and VS Code before 1.90 does not escape `?` for zsh); every session ends | `basic-debug`, `vitest-debug` (also on the minimum VS Code) |

⚠️ marks a requirement no automated test checks yet.

## Out of scope

- Debugging a test with our measuring code in it. Debug runs are plain framework runs, so stepping shows your code only.
