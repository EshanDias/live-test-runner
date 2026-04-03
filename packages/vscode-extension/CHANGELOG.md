# Changelog

All notable changes to Live Test Runner are documented here.

## [2.0.0] — 2026-04-03

Complete rewrite of the extension UI and runner architecture.

### Added

- **Custom Test Explorer** sidebar panel with file → suite → test hierarchy
- **Live Test Results** panel (3 columns: test list, console output, errors)
- **Action bar** — Start Testing, Stop Testing, and Rerun Tests buttons
- **Live watch indicator** shown when the session is active
- **Summary bar** — total / passed / failed counts with elapsed time
- **Failures-only filter** toggle on the test list toolbar
- **Search** bar to filter the test tree by name
- **Collapse All / Expand All** toolbar buttons
- **Per-row rerun** (▶) and **open file** (↗) buttons on hover
- **Duration badges** — color-coded fast / moderate / slow at file, suite, and test level
- **Empty state** message when no tests have been discovered yet
- **Run progress** line showing file count and elapsed time during a run
- `session-started` / `session-stopped` broadcast messages for accurate UI state
- Smart Jest auto-detection: standard Jest, CRA / react-scripts, local `node_modules/.bin/jest`
- `--outputFile` temp-file capture to avoid Windows pipe-buffering data loss
- `stdout` JSON fallback for CRA runs that skip writing `--outputFile` on failure
- Concurrent file runner (up to 3 parallel Jest workers)
- Console output parsed from stderr for CRA projects that omit the `console` array in JSON

### Changed

- Replaced VS Code native Testing API with custom webview-based UI
- `run-finished` message now includes `sessionActive` flag so the explorer restores the correct idle / watching state after a rerun

### Fixed

- Explorer incorrectly showing "watching" state after rerunnning a file when no session was active
- Status bar not restoring to idle after a scope rerun with no active session
- Stack traces stripped from failure messages — only the assertion error is shown
- ANSI escape sequences stripped from failure messages and console output
