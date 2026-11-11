# Coverage

**In one line:** every normal test run also measures coverage, shown as thin coloured bars on each line, and hovering a line lists the tests that ran it.

| | |
|---|---|
| **Who it is for** | Anyone who wants to know what their tests reach, and which test to look at when a line breaks |
| **Frameworks** | Jest (including Create React App), Vitest (needs `@vitest/coverage-v8` or `-istanbul`), Angular (needs `@vitest/coverage-v8`; no covering tests yet), pytest (needs `coverage`) |
| **Requirements** | [Coverage: requirements](../requirements/coverage.md) |
| **How it is built** | [Coverage: design](../development/design/coverage.md) |

---

## The problem

Coverage is usually a separate, slow command that writes an HTML report you open in a browser. It tells you a line was covered, but not by which test.

## What Live Test Runner does

There's no extra command or extra run: the normal runs measure it.

| Bar on the left edge of a line | Meaning |
|---|---|
| ▌ green | The line ran, and every branch on it was taken |
| ▌ amber | The line ran, but a branch was missed (an `if` that was never false) |
| ▌ red | The line never ran |

- **Hover a line** to see which tests ran it, whether they passed, and which branches were missed. **Show All Covering Tests** lists every one.
- **The Coverage tab** in the sidebar has project totals (statements, branches, functions, lines) and a row per file. Click a row to open the file.
- **Files no test imports count as 0%**, so the totals cover the whole project, as your framework's own coverage report does.
- **Your coverage settings apply:** Jest's `collectCoverageFrom`, Vitest's `coverage.include` / `exclude`, coverage.py's `[tool.coverage.run]`.

### While you edit

The bars move with their lines as you type. A line you change or add has no bar until you save and its tests rerun, because an old bar on new code would be wrong. Reformatting keeps the bars. After a save, a grey tint covers the file until its tests have run again on the new code.

### Always the current numbers

Coverage always shows what a fresh full run would report now, not everything that ever ran this session:

- Delete a test, or change it so it reaches less: those lines lose their coverage.
- Delete a test file: its coverage goes with it.
- Stop calling a function from another file: that file's coverage drops.
- Add a source file: it shows as 0% right away (when your coverage settings list the files to cover). Delete or rename one: it leaves the totals.

To keep this exact, a save that reran only single tests is followed, once nothing else is running, by a quiet rerun of those test files in full. While that happens the Coverage tab says **Updating coverage (N files)…** and the totals are greyed out. That rerun also confirms the test results: a test that only fails next to the other tests of its file turns red then.

### Example

You hover line 42 of `pricing.ts`, an `if (member)` line with an amber bar. The hover says `if: ✓ then / ✗ else`, and lists the 3 tests that ran the line, all members. Nobody tests the non-member path.

## What you can change

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.showCoverageInEditor` | `true` | Bars and hover on or off (also the eye button in the editor title) |
| `liveTestRunner.coverageExclude` | `[]` | Extra globs left out of the totals, such as `**/stories/**` |
| `liveTestRunner.coverageThresholds.red` / `.amber` | `50` / `80` | The percentage bands for the totals' colours |

## Good to know

- **No coverage package installed?** Tests still run, and the Coverage tab says what to install.
- Bars never shift your code and leave the gutter free for breakpoints.
- Nothing is written into your project: no `coverage/` folder, no `.coverage` file.
- With Jest, coverage of a Vue component counts its `<script>` block only, as `jest --coverage` does. Its template lines still list the tests that rendered them.
- In a project with both Jest and Vitest, a file tested by both shows the lines either one ran.
- If a test file had to be rerun without coverage (a fallback after a crash), the Coverage tab says so; the totals leave it out until it runs again.

## Related

- [User guide: Code coverage](https://eshandias.github.io/live-test-runner/guide/#coverage)
- [On-save reruns](on-save-reruns.md): the same "which tests ran this line" data picks the tests to rerun
