<!-- # Live Test Runner  -->

<p align="left">
  <b>
    Live Test Runner
    <img 
      src="resources/images/live-test-runner.png" 
      alt="Live Runner Logo" 
      width="70"
      style="vertical-align: middle; padding: 0; margin: 0;"
    >
  </b>
</p>

> Save a file. Tests run. Results appear inline. No terminal. No config.

> **Works with Jest (incl. Create React App) and Vitest** — see [Supported frameworks](#supported-frameworks) for what each one supports.

🌐 **[Website](https://eshandias.github.io/live-test-runner/)** · 📖 **[Read the full guide](https://eshandias.github.io/live-test-runner/guide/)** — or run **Live Test Runner: Open Guide** in VS Code.

<!-- [TODO: USER_INPUT_NEEDED] Replace with an updated hero gif showing the full experience (test run + coverage bars + hover) -->
![Demo](resources/gifs/live%20test%20runner%20demo.gif)

---

## What you get

| | Feature | |
|---|---|---|
| ⚡ | **Live reruns on save** — targeted, file or test level | |
| 🌳 | **Test tree in the sidebar** — file → suite → test, instant on open | |
| 🎨 | **Editor decorations** — gutter icons, inline duration, CodeLens buttons | |
| 📊 | **Per-line code coverage** — coloured bars + hover shows which tests hit each line | |
| 🔍 | **Results panel** — 3-column view: test list · console output · errors | |
| 🗂 | **Monorepos & multi-root workspaces** — every package is a project; switch between them, run several at once | |
| ⏱ | **Timeline Debugger** *(coming soon)* — step through a test like a time-travel debugger | |

---

## Quick Start

1. Open a Jest or Vitest project in VS Code
2. Click the **beaker icon** in the Activity Bar
3. Click **▶ Start Testing**
4. Save any file — results update instantly

> No config changes. No extra installs. The framework is detected from your project.

---

## Features

### Test tree & always-on watching

Your full suite — every file, suite, and test — appears in the sidebar on project open before any run. Tests rerun on every save. The status bar shows a live pass/fail count.

<!-- [TODO: USER_INPUT_NEEDED] Short gif: sidebar tree populating on open, then a test going red/green on save -->
![Explorer Test Cases View](resources/images/explorer-test-run.png)

---

### Editor decorations & CodeLens

Every `it()` / `test()` line gets a gutter icon, inline duration, and action buttons:

- ✓ / ✗ / ⟳ / ○ gutter icons — live from project open
- `▶ Run` · `▷ Debug` · `◈ Results` CodeLens above each block
- Inline duration label, color-coded by threshold

<!-- [TODO: USER_INPUT_NEEDED] Screenshot or short gif of gutter icons + CodeLens in action -->
![Editor decorations](resources/images/editor-decorations.png)

---

### Live code coverage

After the first run, every source file shows per-line coverage — no separate command needed.

| Bar | Meaning |
|-----|---------|
| Green `▌` | Covered by all tests |
| Amber `▌` | Covered by some tests |
| Red `▌` | Never executed |
| Grey `▌` | Not executable |

Hover any line to see which tests cover it, their pass/fail status, and duration (Jest; Vitest shows coverage and branches — covering tests are coming). When more than 5 tests cover a line, click **Show all N** to open a searchable Quick Pick listing every covering test — select one to jump to its result. Coverage updates on every save; files show a grey overlay while a rerun is in progress.

<!-- [TODO: USER_INPUT_NEEDED] Screenshot or gif of coverage bars + hover tooltip in a source file -->
<!-- [TODO: USER_INPUT_NEEDED] Screenshot: coverage bars + hover on a Vitest project (with @vitest/coverage-v8 installed) -->
![Code Coverage Example](resources/images/code_coverage.png)

---

### Monorepos & multi-root workspaces

- Every package with tests is detected as its own project — nothing runs until you start it.
- A **project switcher** at the top of the Explorer shows each project's state (`● running`, `● live`, ✓ / ✗ counts). Pick one: the tree, results and status bar switch to it. Gutter icons, CodeLens and coverage bars always show each file's own project.
- **▶ Start / ⏹ Stop act on the project shown.** Others keep running (and rerunning on save) in the background.
- A root config that already covers its packages (Jest `projects`, Vitest `test.projects`) stays one project; Vitest projects are grouped by name in the tree.
- `maxRunningProjects` limits how many run at once.

<!-- [TODO: USER_INPUT_NEEDED] gif: a pnpm monorepo — open the switcher, start two packages, switch between them while both run -->

---

### Results panel

3-column view: test tree with search · console output tabbed by level · failure messages and stack traces.

<!-- [TODO: USER_INPUT_NEEDED] Screenshot of the 3-column results panel -->
![Results panel](resources/images/test-results-column-split.png)

---

### Timeline Debugger *(coming soon)*

Step through any test case line by line — variable values as inline ghost text, watch panel, call stack, no breakpoints needed.

<!-- [TODO: USER_INPUT_NEEDED] Preview gif or screenshot of timeline debugger once available -->

---

## Commands

| Command | What it does |
|---------|-------------|
| `Start Testing` | Run all tests and start watching |
| `Stop Testing` | End the session |
| `Stop Testing and Clear Cache` | Stop + wipe discovery cache |
| `Clear Cache and Restart Testing` | Fresh restart |
| `Select Project` | Switch the project shown (same as the Explorer's switcher) |
| `Select Project Root` | Pin Live Test Runner to one folder (or back to all projects) |
| `Stop All Projects` | Stop every running project |
| `Show Logs` | Open the extension log (filter by level) |
| `Show Test Output` | Open the raw test-runner output |
| `Copy Diagnostic Report` | Copy versions, setup and recent logs for a bug report |
| `Open Guide` | Open the user guide in an editor tab |

> **Tip:** Shift-click **⏹ Stop** to stop and clear cache in one click.

---

## Troubleshooting

- **Output → "Live Test Runner"** — what the extension did: one line per run, warnings when something falls back. Set the level to **Debug** (⚙ in the Output panel) for details.
- **Output → "Live Test Runner: Test Output"** — exactly what Jest / Vitest printed.
- Reporting a bug? Run **Copy Diagnostic Report** and attach it.

<!-- [TODO: USER_INPUT_NEEDED] Screenshot of the Output panel showing the levelled "Live Test Runner" log with a Run summary line -->


---

## Configuration

All settings under `liveTestRunner.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `projectRoot` | `""` | Pin to one project root; empty = detect every project in the workspace |
| `maxRunningProjects` | `"auto"` | Projects running at once: `auto` = 2 (1 on ≤ 4 cores or < 8 GB total memory), or a number |
| `runMode` | `"auto"` | `"auto"` calls Jest directly; `"npm"` delegates to `npm test` (Jest only) |
| `jestCommand` | `""` | Override Jest binary path |
| `vitestCommand` | `""` | Override the Vitest command (e.g. `npx vitest`); empty = the project's own Vitest |
| `vitestIncludeBrowserProjects` | `false` | Also run Vitest browser-mode projects (need Playwright / WebdriverIO browsers) |
| `onSaveDebounceMs` | `300` | Debounce delay after save (ms) |
| `hangTimeoutSeconds` | `300` | Stop a single test running longer than this (e.g. an infinite loop) and mark it failed; `0` = no limit |
| `testFilePatterns` | `["**/*.test.*", "**/*.spec.*", "**/__tests__/**/*.*"]` | Which files appear in the test tree. Jest's own config still decides what runs, and files it runs are added even when no pattern matches |
| `coverageExclude` | `[]` | Extra globs left out of the coverage totals (which otherwise follow your Vitest `coverage.include` / `exclude` or Jest `collectCoverageFrom`) |
| `durationThresholds.testAmberMs` | `100` | Test turns amber |
| `durationThresholds.testRedMs` | `500` | Test turns red |
| `durationThresholds.suiteAmberMs` | `500` | Suite turns amber |
| `durationThresholds.suiteRedMs` | `2000` | Suite turns red |
| `durationThresholds.fileAmberMs` | `1000` | File turns amber |
| `durationThresholds.fileRedMs` | `5000` | File turns red |

---

## Supported frameworks

<!-- matrix:start -->
| Feature | Jest | CRA | Vitest |
|---|---|---|---|
| Run & pass/fail | ✅ | ✅ | ✅ |
| ▶ Run / ▷ Debug one test or suite | ✅ | ✅ | ✅ |
| Rerun a saved test file | ✅ | ✅ | ✅ |
| Logs / console output | ✅ per file | ✅ per file | ✅ per test |
| Coverage (gutter, hover) | ✅ | ✅ | ✅ needs `@vitest/coverage-v8` (or `-istanbul`) |
| Live per-file progress | ✅ | ✅ | ✅ |
| Rerun tests related to a saved source file | ✅ | ✅ | ✅ whole test files (`vitest related`) |
| Monorepo / multi-project (project switcher) | ✅ one project per package; a root `projects` config stays one | 🟡 a CRA app is detected as a package (not e2e-tested) | ✅ one project per package; `test.projects` stays one, grouped by name |
| Mixed frameworks in one project | — | — | ⏳ 3.2 |
| Execution trace / "covering tests" | ✅ | ✅ | ⏳ 3.3 |
| Timeline debugger | ⏳ | ⏳ | ⏳ later |
<!-- matrix:end -->

<!-- [TODO: USER_INPUT_NEEDED] gif: Start Testing on a Vitest project — the test tree fills in, results and gutter icons appear, ▶ Run on one test -->

Vitest 3 or newer is fully supported; Vitest 1–2 run with results only. Projects that list Vitest but configure Jest (e.g. libraries testing with both) run on Jest.

---

## Known limitations

- Individual test reruns use `--testNamePattern` — tests with exactly the same full name run together
- Jest captures console output per file; it shows on a single test only when that test is rerun on its own. With Vitest every test shows its own output.
- Test-level granularity and per-test console logs are only available after the background trace pass completes for a file; whole-file reruns are used as fallback
- Vitest: saving a source file reruns the whole test files that import it (`vitest related`); per-test reruns need the execution trace, coming in a later release

---

## About

<p align="center">
  <img src="resources/images/bradlogo.png" alt="Brand Logo" width="150">
</p>

Built by **EshLabs** (Eshan Dias) — a software engineer who wanted live test feedback without paying for third-party tools.

⭐ [Star on GitHub](https://github.com/eshandias/live-test-runner) · 🐛 [Report an issue](https://github.com/eshandias/live-test-runner/issues)

---

MIT License
