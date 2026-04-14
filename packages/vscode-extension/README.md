<!-- # Live Test Runner  -->

<p align="left" style="font-size: 40px;">
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

---
</br>

![v1 Demo](resources/gifs/live-test-runner-v1-demo.gif)

> **Only Supports `Jest` at the moment**

---

## Why Live Test Runner?

Most test runners make you switch context — open a terminal, run a command, scroll through output. Live Test Runner brings tests into the editor. Save a file and your results update instantly. Click a line and jump straight to the failure. Everything is one panel away.

No configuration required for standard Jest projects. No dependency on the VS Code Test Explorer API.

---

## Features

### Static test discovery on project open

The full test tree — every file, suite (at any nesting depth), and test case — appears in the sidebar the moment you open a project, before you click Start Testing. Line numbers, pending `○` icons, and `▶ Run` / `▷ Debug` CodeLens buttons are all live from the first file scan. No warm-up run required.

The extension parses your test files in the background using Babel's AST (your project's own Babel — nothing extra to install). Large projects (500+ files, 3000+ tests) stay responsive because discovery runs in batches with event-loop yields between them.

Test files are watched for changes. Add a test case, save the file, and it appears in the tree immediately.

---

### Always-on test watching

Tests re-run automatically on every save. A status bar badge gives you a one-glance pass/fail count without opening the panel.

![Status Bar](resources/images/status_bar.png)

---

### Custom Test Explorer

A sidebar panel shows your full test suite as a recursive **file → suite → … → test** tree with unlimited nesting depth. Every row has live status icons and color-coded duration badges. When one test fails, its parent suites light up in red all the way to the file level.

![Explorer Test Cases View](resources/images/explorer-test-run.png)
---

### Live Results panel

A three-column split view for deep inspection:

| Column | What it shows |
|--------|--------------|
| **Tests** | The same recursive test tree, with search and filters |
| **Output** | Console logs for the selected test, tabbed by level (All / Logs / Info / Warn / Error) |
| **Errors** | Failure messages and stack traces for the selection |

![Explorer Test Cases View](resources/images/test-results-column-split.png)

---

### Editor decorations & CodeLens

Every `it()` and `test()` line gets:

- **Gutter icon** — ✓ pass (green) · ✗ fail (red) · ⟳ running (amber) · ○ pending (grey) — present from project open, before any test is run
- **Inline duration** — muted label after the closing paren, color-coded by threshold
- **`▶ Run`** — rerun just this test (or suite, or file) without touching anything else
- **`▷ Debug`** — launch Jest under the debugger, scoped to this test via `--testNamePattern`
- **`◈ Results`** — jump straight to this test in the Results panel

![Explorer Test Cases View](resources/images/editor-decorations.png)

---

### Test Timeline Debugger - Coming Soon

Step through a single test case like a time-travel debugger — no breakpoints, no `debugger` statements, no terminal.

Click the **`⏱ Timeline`** CodeLens above any `it()` or `test()` line (or the `⏱` button on a test row in the sidebar) to start a trace. Live Test Runner re-runs that test with instrumentation injected at transform time and records every executed line, every variable value, and every log entry.

When the trace completes:

- The **timeline bar** shows one box per step. Click any box or use the controls (`⏮ ◀ ▶ ▶| ⏭ ⏸`) to replay the execution.
- The **editor** highlights the active line and shows variable values as inline ghost text. Hover a variable for its full history across steps and an `[Add to Watch]` action.
- The **sidebar State panel** shows all variables captured at the current step. Objects and arrays are lazily expandable.
- The **Watch panel** lets you pin any variable and track its value as you step through.
- The **Call Stack panel** shows the function chain at the current step — click any frame to jump to that line.
- The **Console tab** shows cumulative logs up to the current step. The **Errors tab** shows all failure messages.

Zoom the timeline bar with the mouse wheel to group steps by line / function / file. Drag to scrub through steps in real time. Click `↺ Re-run` in the sidebar to re-trace at any time.

No test file is ever modified on disk — instrumentation is injected at Jest transform time only.

---

### Smart Jest detection

Automatically detects:

- Standard `jest` in `node_modules/.bin`
- Create React App / `react-scripts test`
- Custom commands via the `liveTestRunner.jestCommand` setting

---

## Quick Start

1. Open a Jest project in VS Code
2. Click the **beaker icon** in the Activity Bar to open Live Test Runner — your test tree appears automatically as files are scanned
3. Click **▶ Start Testing** to run the full suite for the first time and start the live watch session
4. Edit any source or test file, save, and watch results update in real time

> Always run **▶ Start Testing** at least once per session. Discovery shows you the test tree upfront, but results, gutter icons, and on-save reruns only activate after the first run.

> No `jest.config` changes needed. No extra dependencies to install.

---

## Commands

| Command | Description |
|---------|-------------|
| `Live Test Runner: Start Testing` | Discover and run all tests, then start watching for saves |
| `Live Test Runner: Stop Testing` | End the current session |
| `Live Test Runner: Select Project Root` | Pick a root in a multi-folder workspace |
| `Live Test Runner: Show Raw Output` | Open the raw Jest output channel for debugging |

---

## Configuration

All settings are under `liveTestRunner.*` in VS Code settings.

### General

| Setting | Default | Description |
|---------|---------|-------------|
| `liveTestRunner.projectRoot` | `""` | Project root (auto-detected for single-folder workspaces) |
| `liveTestRunner.runMode` | `"auto"` | `"auto"`: extension calls Jest directly for full structured output. `"npm"`: delegates to your `npm test` script — useful when Jest is wrapped or non-standard, but per-test durations and gutter icons may be limited. |
| `liveTestRunner.jestCommand` | `""` | Override the Jest command (e.g. `node_modules/.bin/jest`). Only used when `runMode` is `"auto"`. |
| `liveTestRunner.onSaveDebounceMs` | `300` | Milliseconds to wait after a save before triggering a run |

### Duration thresholds

Control when duration badges switch from green → amber → red. Separate thresholds per level so suite and file budgets aren't judged by the same bar as individual tests.

| Setting | Default | Level |
|---------|---------|-------|
| `liveTestRunner.durationThresholds.testAmberMs` | `100` | Test turns amber |
| `liveTestRunner.durationThresholds.testRedMs` | `500` | Test turns red |
| `liveTestRunner.durationThresholds.suiteAmberMs` | `500` | Suite turns amber |
| `liveTestRunner.durationThresholds.suiteRedMs` | `2000` | Suite turns red |
| `liveTestRunner.durationThresholds.fileAmberMs` | `1000` | File turns amber |
| `liveTestRunner.durationThresholds.fileRedMs` | `5000` | File turns red |

---

## Status Bar

| Badge | Meaning |
|-------|---------|
| `Live Tests: Off` | No session active |
| `Live Tests: Discovering…` | Finding test files |
| `Live Tests: Tracing... N/M` | Collecting all traces |
| `Live Tests: Running… N/M` | Run in progress |
| `Live Tests: ✅ N passed` | All tests passed |
| `Live Tests: ❌ N failed, M passed` | Failures present |

---

## Supported Frameworks

| Framework | Status |
|-----------|--------|
| Jest | Fully supported |
| Create React App (react-scripts) | Fully supported |
| Vitest | Planned |

---

## Known Limitations

- Rerunning an individual test uses `--testNamePattern`, which may match multiple tests if names overlap
- Smart on-save reruns use test-level granularity only after the first full session run completes (the background trace pass needs to finish for at least one file). Before that, whole test files are rerun as a fallback.
- Console logs are attributed to individual tests after the background trace pass completes for that file. Before the trace finishes, logs are only available at file level.

---
## About

<p align="center">
  <img src="resources/images/bradlogo.png" alt="Brand Logo" width="150">
</p>

This software is built by `EshLabs` (Eshan Dias). I’m a software engineer who was tired of paying for third-party tools, so I decided to create my own tools to help streamline development.  

I built this tool because during development, we often forget about test cases, and running them after completing a project to find errors can take a lot of time. With this tool, I can immediately see if any test cases fail as I code, making the debugging process faster and more efficient.  

If this tool helps you as much as it helps me, please give it a ⭐ on [GitHub](https://github.com/eshandias/live-test-runner)!

---

## Contributing

Bug reports, feature requests, and pull requests are welcome at [github.com/eshandias/live-test-runner](https://github.com/eshandias/live-test-runner).

---

## License

MIT
