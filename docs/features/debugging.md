# Debugging

**In one line:** `▷ Debug` above a test starts VS Code's debugger for exactly that test or group, with breakpoints in tests and source files working as usual.

| | |
|---|---|
| **Who it is for** | Anyone stepping through a failing test |
| **Frameworks** | Jest (including Create React App), Vitest, pytest (needs the Python Debugger extension) |
| **Requirements** | [Debugging: requirements](../requirements/debugging.md) |
| **How it is built** | [Debugging: design](../development/design/debugging.md) |

---

## The problem

Debugging a single test usually means writing a `launch.json` by hand: the right binary, the right config, the test-name filter, the right flags so the framework doesn't run in parallel workers or time out while you're paused. The details differ for every framework and operating system.

## What Live Test Runner does

Click `▷ Debug` above a test or a `describe` / class. The extension builds the launch config and starts the debugger:

| Framework | What it starts |
|---|---|
| Jest | Node debugger running Jest in band (one process), only that test, no coverage. Create React App projects use their own Jest config |
| Vitest | Node debugger running Vitest's CLI, one file at a time, with no test timeouts while you're paused. Worker processes attach automatically |
| pytest | The Python Debugger (`debugpy`) running `python -m pytest <test id>` with the project's own Python |

Set breakpoints in the test or in the code it calls before clicking. The run is a plain framework run, so what you see is what the framework does without Live Test Runner.

### Example

`applies member discount` fails. You put a breakpoint inside `applyDiscount()` and click `▷ Debug` above the test. The debugger stops at your breakpoint, and only that one test runs.

## Good to know

- `▷ Debug` works whether or not testing is on.
- **pytest needs the Python Debugger extension** (`ms-python.debugpy`). Without it, a message offers to install it and nothing starts.
- Your test script's flags apply (`--config`, `--resetMocks`, Node options such as Jest's ESM mode).
- Jest and Vitest pick the test by a name pattern, so tests whose names overlap can run together.
- Jest and Vitest output (results, `console.log`) appears in the **Debug Console**. The test starts straight away, however long your terminal's shell takes to start.

## Related

- [User guide: Debugging](https://eshandias.github.io/live-test-runner/guide/#debugging)
