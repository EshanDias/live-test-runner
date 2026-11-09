# Results panel

**In one line:** one panel shows every test's result, the console output it printed, and why it failed, scoped to whatever file, group or test you select.

| | |
|---|---|
| **Who it is for** | Anyone reading why a test failed or what it printed |
| **Frameworks** | Jest (including Create React App), Vitest, pytest |
| **Requirements** | [Results panel: requirements](../requirements/results-panel.md) |
| **How it is built** | [Results panel: design](../development/design/results-panel.md) |

---

## The problem

In a terminal, test output is one long scroll. Console lines from many tests are interleaved, and the failure you care about is somewhere in the middle. VS Code's built-in test panel also has a macOS bug where a test's output can show as empty.

## What Live Test Runner does

The panel opens at the bottom of VS Code and has three columns:

| Tests | Output | Errors |
|---|---|---|
| The same tree as the sidebar. Click a row to choose what the other columns show | Console output of the selection, with tabs for log, info, warn and error. Each line has a copy button, and **Copy all** copies what the tab shows | The failures of the selection: the message, expected and received values, and where in the code it failed. Each has a copy button; **Copy all** copies every failure shown, **Copy for AI** adds the test's source and the lines it was thrown from |

- **Selecting a file** shows the file's output and every failure in it. **Selecting a group or a test** narrows both columns to it.
- Selection is shared: picking a test in the sidebar picks it in the panel, and `◈ Results` above a test in the editor jumps to it.
- Results update live while tests run.
- **Copy for AI** puts on your clipboard what an AI assistant needs to explain a failure: the framework, the test's name and file, the error, the test's code and the lines of your code the error came from. It only goes to the clipboard; you decide where to paste it. **Copy Failing Test Names** (the copy icon in the panel's title bar, or the Command Palette) copies `file › test` for every failing test.

### Which output a test shows

Frameworks report console output differently, and the panel only shows what the framework actually said:

| Framework | Output of a single test |
|---|---|
| Vitest, pytest | Shown right away: the framework says which test printed each line |
| Jest | Jest only reports output per file. A single test shows its own output after you rerun that test on its own (`▶ Run`). Until then it shows a placeholder |

Output from the file is never copied into a test, because it would show lines the test didn't print.

### Example

`cart.test.ts` fails 2 of 40 tests. Click the file: the Errors column lists both failures with their diffs. Click the first failing test: Errors shows only its failure. With Vitest, Output shows only the `console.log` lines that test printed.

## Good to know

- pytest shows each test's `print` output, its stderr and its log records. With `-s` in your `addopts`, output goes to the **Live Test Runner: Test Output** channel instead.
- The raw framework output of every run is in the **Live Test Runner: Test Output** channel. The extension's own log is in **Live Test Runner**.

## Related

- [User guide: Results panel](https://eshandias.github.io/live-test-runner/guide/#results)
- [Test Explorer and editor](test-explorer.md)
