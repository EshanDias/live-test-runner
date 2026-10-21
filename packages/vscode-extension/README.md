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

Hover any line to see which tests cover it, their pass/fail status, and duration. When more than 5 tests cover a line, click **Show all N** to open a searchable Quick Pick listing every covering test — select one to jump to its result. Coverage updates on every save; files show a grey overlay while a rerun is in progress.

<!-- [TODO: USER_INPUT_NEEDED] Screenshot or gif of coverage bars + hover tooltip in a source file -->
![Code Coverage Example](resources/images/code_coverage.png)

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
| `Select Project Root` | Pick root in multi-folder workspace |
| `Show Logs` | Open the extension log (filter by level) |
| `Show Test Output` | Open the raw test-runner output |
| `Copy Diagnostic Report` | Copy versions, setup and recent logs for a bug report |

> **Tip:** Shift-click **⏹ Stop** to stop and clear cache in one click.

---

## Troubleshooting

- **Output → "Live Test Runner"** — what the extension did: one line per run, warnings when something falls back. Set the level to **Debug** (⚙ in the Output panel) for details.
- **Output → "Live Test Runner: Test Output"** — exactly what Jest printed.
- Reporting a bug? Run **Copy Diagnostic Report** and attach it.

<!-- [TODO: USER_INPUT_NEEDED] Screenshot of the Output panel showing the levelled "Live Test Runner" log with a Run summary line -->


---

## Configuration

All settings under `liveTestRunner.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `projectRoot` | `""` | Auto-detected for single-folder workspaces |
| `runMode` | `"auto"` | `"auto"` calls Jest directly; `"npm"` delegates to `npm test` (Jest only) |
| `jestCommand` | `""` | Override Jest binary path |
| `vitestCommand` | `""` | Override the Vitest command (e.g. `npx vitest`); empty = the project's own Vitest |
| `vitestIncludeBrowserProjects` | `false` | Also run Vitest browser-mode projects (need Playwright / WebdriverIO browsers) |
| `onSaveDebounceMs` | `300` | Debounce delay after save (ms) |
| `hangTimeoutSeconds` | `300` | Stop a single test running longer than this (e.g. an infinite loop) and mark it failed; `0` = no limit |
| `testFilePatterns` | `["**/*.test.*", "**/*.spec.*", "**/__tests__/**/*.*"]` | Which files appear in the test tree. Jest's own config still decides what runs, and files it runs are added even when no pattern matches |
| `coverageExclude` | `[]` | Extra globs left out of the coverage totals |
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
| Coverage (gutter, hover) | ✅ | ✅ | ⏳ 3.0 |
| Live per-file progress | ✅ | ✅ | ⏳ 3.0.x |
| Rerun tests related to a saved source file | ✅ | ✅ | ⏳ 3.0.x |
| Monorepo / multi-project | 🟡 | — | 🟡 Vitest `projects`, run from the root |
| Mixed frameworks in one project | — | — | ⏳ 3.2 |
| Execution trace / "covering tests" | ✅ | ✅ | ⏳ 3.3 |
| Timeline debugger | ⏳ | ⏳ | ⏳ 3.4 |
<!-- matrix:end -->

<!-- [TODO: USER_INPUT_NEEDED] gif: Start Testing on a Vitest project — the test tree fills in, results and gutter icons appear, ▶ Run on one test -->

Vitest 3 or newer is fully supported; Vitest 1–2 run with results only. Projects that list Vitest but configure Jest (e.g. libraries testing with both) run on Jest.

---

## Known limitations

- Individual test reruns use `--testNamePattern` — tests with exactly the same full name run together
- Jest captures console output per file; it shows on a single test only when that test is rerun on its own. With Vitest every test shows its own output.
- Test-level granularity and per-test console logs are only available after the background trace pass completes for a file; whole-file reruns are used as fallback

---

## About

<p align="center">
  <img src="resources/images/bradlogo.png" alt="Brand Logo" width="150">
</p>

Built by **EshLabs** (Eshan Dias) — a software engineer who wanted live test feedback without paying for third-party tools.

⭐ [Star on GitHub](https://github.com/eshandias/live-test-runner) · 🐛 [Report an issue](https://github.com/eshandias/live-test-runner/issues)

---

MIT License
