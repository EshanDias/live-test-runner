# Live Test Runner

A VS Code extension that runs your Jest tests automatically on save and presents results in a clean, purpose-built UI — no native Test Explorer API required.

## Features

- **On-save testing** — tests re-run automatically whenever you save a file
- **Custom Test Explorer** — sidebar panel showing file → suite → test hierarchy with status icons, durations, and color coding
- **Live Test Results panel** — three-column view: test list, console output (tabbed by level), and error details
- **Smart Jest detection** — auto-detects standard Jest and Create React App / react-scripts projects; respects `package.json` scripts and local `node_modules`
- **Session management** — explicit Start / Stop / Rerun controls; nothing runs in the background until you start a session
- **Summary bar** — live total / passed / failed counts with elapsed time after each run
- **Failures-only filter** — hide passing tests to focus on what's broken
- **Search** — filter the test tree by name in real time
- **Collapse / Expand all** — keyboard-friendly tree controls
- **Per-row actions** — rerun a single file, suite, or test; open the source file in the editor
- **Duration indicators** — color-coded fast / moderate / slow badges at every level
- **Status bar** — quick-glance summary of the last run

## Quick Start

1. Open a Jest project in VS Code
2. Click the beaker icon in the Activity Bar to open **Live Test Runner**
3. Click **▶ Start Testing** — the extension discovers test files, runs them all, and begins watching for saves
4. Edit a test or source file, save, and watch the results update live

## Commands

| Command | Description |
|---------|-------------|
| `Live Test Runner: Start Testing` | Discover and run all tests, then start watching |
| `Live Test Runner: Stop Testing` | Stop the session |
| `Live Test Runner: Select Project Root` | Choose a project root in a multi-folder workspace |
| `Live Test Runner: Show Raw Output` | Open the raw Jest output channel |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `liveTestRunner.projectRoot` | `""` | Project root directory (auto-detected for single-folder workspaces) |
| `liveTestRunner.jestCommand` | `""` | Override Jest command (e.g. `node_modules/.bin/jest`). Leave empty to auto-detect. |
| `liveTestRunner.onSaveDebounceMs` | `300` | Delay in ms before running tests after a save |
| `liveTestRunner.durationThresholds.testAmberMs` | `100` | Test duration (ms) at which the badge turns amber |
| `liveTestRunner.durationThresholds.testRedMs` | `500` | Test duration (ms) at which the badge turns red |
| `liveTestRunner.durationThresholds.suiteAmberMs` | `500` | Suite duration (ms) at which the badge turns amber |
| `liveTestRunner.durationThresholds.suiteRedMs` | `2000` | Suite duration (ms) at which the badge turns red |
| `liveTestRunner.durationThresholds.fileAmberMs` | `1000` | File duration (ms) at which the badge turns amber |
| `liveTestRunner.durationThresholds.fileRedMs` | `5000` | File duration (ms) at which the badge turns red |

## Status Bar

| Text | Meaning |
|------|---------|
| `Live Tests: Off` | No session active |
| `Live Tests: Discovering…` | Finding test files |
| `Live Tests: Running… N/M` | Run in progress |
| `Live Tests: ✅ N passed` | Last run passed |
| `Live Tests: ❌ N failed, M passed` | Last run had failures |

## Supported Frameworks

- **Jest** — fully supported, including Create React App / react-scripts projects
- More frameworks planned for future.

## Known Limitations

- Rerunning an individual test uses `--testNamePattern` which may match multiple tests if names overlap
- Rerunning a `describe` block with no matching entry in the line map falls back to running the whole file

## Contributing

File issues and feature requests at [GitHub](https://github.com/eshandias/live-test-runner).

## License

MIT
