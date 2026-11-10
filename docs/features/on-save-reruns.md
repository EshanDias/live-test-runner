# On-save reruns

**In one line:** after you click **Start** once, every save reruns only the tests your change can affect, and the results appear in the editor within seconds.

| | |
|---|---|
| **Who it is for** | Anyone writing code with tests: you see whether a change broke something while you are still looking at it |
| **Frameworks** | Jest (including Create React App), Vitest, Angular (Vitest through `ng test`), pytest |
| **Requirements** | [On-save reruns: requirements](../requirements/on-save-reruns.md) |
| **How it is built** | [On-save reruns: design](../development/design/on-save-reruns.md) |

---

## The problem

Running the whole test suite after every change is slow, so people run it rarely and find out late that something broke. Watch modes in test frameworks help, but they rerun whole test files, need a terminal, and show results far from the code.

## What Live Test Runner does

1. **Click Start once.** Every test runs. While they run, the extension records which lines of your code each test executes.
2. **Save a file.** Only the tests that depend on it run again:

   | You save… | What reruns |
   |---|---|
   | A test file | That file |
   | A source file | Only the tests that ran a line of it. If some tests in a group share variables, the whole group reruns, so the result stays correct. |
   | A source file no test has run yet | The test files that import it, directly or through other files |
   | A test or project config (`jest.config.js`, `vitest.config.ts`, `pyproject.toml`…) | Everything, because the config can change which tests exist and how they run |

3. **See the result where you are.** Gutter icons turn ✓ or ✗, the Results panel updates, and coverage bars refresh.

### Example

`cart.test.ts` has 40 tests, and 3 of them call `applyDiscount()` in `pricing.ts`. You change `applyDiscount()` and save. Only those 3 tests run, not 40, and not the whole suite.

## Changes from outside the editor

`git pull`, a branch switch or a code generator also changes files. While testing is on, these changes rerun tests the same way a save does:

- **A few files changed:** the tests that depend on them rerun.
- **More than 20 files at once** (a branch switch): everything reruns.
- **Files changed while tests are running:** they wait, and their tests rerun when the run finishes.
- **Files the tests write themselves** (snapshots, generated fixtures) don't start reruns forever. The extension notices and stops, and the log says why.

## What you can change

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.onSaveDebounceMs` | `300` | How long to wait after a save before running, so quick repeated saves run once |
| `liveTestRunner.vitestTrace` | `true` | Vitest only: record which lines each test runs. When off, a save reruns the test files that import the saved file (`vitest related`) |

## Good to know

- **Nothing runs before you click Start**, and **Stop is final**. A save never starts tests in the background without your say. Clicking `▶ Run` above a test always works.
- **A test that only reads a file** (for example a JSON fixture loaded with `fs`) is not linked to it, because no line of code in it runs. Saving that file reruns nothing. Save the test file instead.
- **Angular** has no execution trace yet: a save reruns the test files that import the saved file (relative imports, followed through other files), and a template (`templateUrl`) reruns its component's tests. A file imported only through a path alias reruns every test of its project.
- Jest and Vitest rerun a single test by a name pattern, so tests whose names overlap can run together. pytest reruns by exact test id.

## Related

- [User guide: Reruns on save](https://eshandias.github.io/live-test-runner/guide/#on-save)
