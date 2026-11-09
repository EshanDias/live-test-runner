# Test Explorer and editor

**In one line:** every test in the project is listed the moment you open it, and each test in the editor gets a status icon, its duration and `▶ Run` / `▷ Debug` buttons.

| | |
|---|---|
| **Who it is for** | Anyone who wants to see and run tests without a terminal |
| **Frameworks** | Jest (including Create React App), Vitest, Angular (Vitest through `ng test`), pytest |
| **Requirements** | [Test Explorer and editor: requirements](../requirements/test-explorer.md) |
| **How it is built** | [Test Explorer and editor: design](../development/design/test-explorer.md) |

---

## The problem

In most setups you only learn which tests exist by running them. Results then appear in a terminal, far from the code, and running a single test means typing its name into a command.

## What Live Test Runner does

**The tree is ready before anything runs.** When you open a project, the extension reads the test files (without running them) and builds a tree in the sidebar: file → `describe` group → test, nested as deep as your code goes.

- **Dynamic tests** (`test.each`, `@pytest.mark.parametrize`, template-literal names) appear as one entry that fills in with the real cases after a run.
- **Live updates:** adding, renaming or deleting a test updates the tree as you save.
- **Fast reopening:** the parsed tree is cached, and only files changed since are read again.
- **Score cards:** Total, Passed, Failed, plus Running while tests run. Click one to filter the tree; there is also a search box.

**In the editor, next to each test:**

| Where | What you see |
|---|---|
| Gutter | ✓ passed · ✗ failed · ⟳ running · ○ not run yet · ⊖ skipped · ☐ todo (`test.todo`, `it.todo`) |
| After the line | How long the test took, coloured green, amber or red |
| After a failing line | Why the test failed (`✗ Expected 3, received 2`), on the line of the test where it failed and on the line of your code an error was thrown from. Hover it for the whole message, **Show diff** (expected and received side by side), **Open in Results** and **Dismiss**. A changed snapshot (Jest, Vitest) also offers **Update snapshot** |
| Above the line | `▶ Run` this test or group · `▷ Debug` it · `◈ Results` to jump to it in the Results panel |
| Status bar | `Live Tests: ✅ 12 passed`. Click it to open the panels |

`▶ Run` and `▷ Debug` work even when testing is off: you asked for that one run.

### Example

You open a project with 58 test files. Before you click anything, the sidebar lists all 412 tests, and the test file you have open shows ○ next to each test. Click `▶ Run` above one test: only that test runs, and its ○ turns to ✓ with "12 ms" after it.

## What you can change

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.testFilePatterns` | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**/*.*` | Which files to list before the framework is asked. Files your framework's config runs are added anyway |
| `liveTestRunner.showFailuresInEditor` | `true` | The failure message on the failing line, and its hover |
| `liveTestRunner.durationThresholds.*` | test 100 / 500 ms, suite 500 / 2000 ms, file 1000 / 5000 ms | When a duration turns amber, then red |

## Good to know

- The tree comes from reading the code, so a test whose name is built at runtime shows a placeholder name (`accepts …`) until it runs.
- Once a file has run, the framework's own line numbers replace the ones found by reading the code.
- A failure message disappears from a line you edit: it may no longer be about that line. It comes back with the next run. **Dismiss** hides one until its test runs again.
- **Update snapshot** always asks first, in a dialog that names the file that will change (the `.snap` file, or the test file itself for an inline snapshot). Then your framework rewrites only that test's snapshot, as `jest -u` / `vitest -u` would for that one test; your other tests' snapshots stay. Like `-u`, it also removes snapshots in that file that no test uses any more; the dialog says so. With unsaved changes in that file it asks you to save first. Review the change before you commit it. pytest snapshot plugins are not supported.
- **Show diff** needs the framework to print both values (Jest and Vitest do for comparisons such as `toBe` and `toEqual`); pytest messages show without a diff.
- Skipped and `todo` tests show as skipped, not as "not run"; a `todo` test has its own icon, so tests still to write stand out. Both count as skipped in the totals.

## Related

- [User guide: Test Explorer](https://eshandias.github.io/live-test-runner/guide/#explorer)
- [Results panel](results-panel.md)
