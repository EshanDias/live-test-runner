# Changelog

All notable changes to Live Test Runner are documented here.

---

## [1.0.0] — 2026-04-03

### Initial release

#### Features
- **Auto-detection** — automatically discovers the package manager (npm, pnpm, yarn) and Jest
  binary used by the workspace; no configuration required for standard setups
- **Live test execution** — runs Jest tests on file save and surfaces results in real time without
  waiting for the full run to finish
- **Test hierarchy in sidebar** — the VS Code Testing panel shows files, describe suites, and
  individual test cases as a collapsible tree, updated live as each file finishes
- **Status indicators** — spinning indicator while a file is running; ✓ / ✗ icons with green/red
  colouring once results arrive; pass/fail/skip counts shown at the file level
- **Durations** — per-file and per-test durations displayed inline; files taking over 3 s are
  highlighted in yellow, over 10 s in red
- **Concurrent execution** — test files run in parallel (up to the worker pool limit); the sidebar
  updates file-by-file rather than waiting for the entire suite
- **ANSI output channel** — a dedicated "Live Test Runner (ANSI)" output channel shows full Jest
  output with colours, including startup logs and the exact command invoked
- **Diagnostics** — failed tests produce red squiggles in the editor at the failing line; cleared
  automatically on the next passing run
- **Project root selection** — command to manually select the project root when auto-detection is
  insufficient (useful for monorepos)
- **Status bar** — shows current state (Off / Running… N/M / ✅ N passed / ❌ N failed) with a
  click-to-start shortcut
- **Commands**: Start Testing, Stop Testing, Run Related Tests (current file), Refresh Tests,
  Rebuild Map, Clear Diagnostics, Show Output, Select Project Root

#### Known Limitations & Bugs

- **Per-test output not shown on macOS** — clicking an individual test case in the VS Code Test
  Results panel shows *"The test case did not report any output."* on macOS. The global run output
  (visible via the "Show Results Output" button) is complete and unaffected. This is caused by
  inconsistent behaviour in the VS Code `TestRun.appendOutput()` API on macOS when a `test`
  parameter is supplied. The fix (a custom interactive panel) is planned for v1.1.0.

- **No per-test click-to-view output** — as a consequence of the above, there is currently no way
  to click a passing test and see its isolated output. Failure messages for failed tests do appear
  in the Messages tab of the Test Results panel on all platforms.

- **Monorepo support is manual** — in workspaces with multiple Jest configs the correct project
  root must be set manually via the "Select Project Root" command.

- **No coverage support** — code coverage is not yet surfaced in the UI. Planned for a future
  release.

- **Windows path edge cases** — Jest normalises file paths differently on Windows; path matching
  uses `fileResults[0]` as a workaround and may behave unexpectedly in edge cases with multiple
  Jest projects in a single config.

---

## Roadmap

### v1.1.0 — Custom interactive panel
- Custom WebviewView panel replacing reliance on the native VS Code Test Results panel
- Full file → suite → test tree with live status icons and durations
- Click any row (file, suite, or test case) to view scoped log output in a side pane
- Start / Stop / Reset toolbar buttons inside the panel
- Cross-platform, no dependency on `appendOutput` API behaviour

### Future
- Coverage overlay (% per file in tree)
- Filter: show failures only
- Re-run a single file or single test from the custom tree
- Persistent results across window reloads
