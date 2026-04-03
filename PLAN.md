# Live Test Runner — Custom Interactive Panel Plan

## Background

The VS Code native Test Results panel has a Mac-specific bug where clicking an individual test shows
"The test case did not report any output." even when `run.appendOutput()` is called with the test
item parameter. This works on Windows but not Mac. The root cause is a VS Code API limitation —
`appendOutput` with a `test` parameter was added in VS Code 1.87 and behaves inconsistently on Mac
regardless of version.

The fix is to build a fully custom interactive WebviewView panel that we own entirely, giving us
cross-platform control over the test results UI.

---

## What We Want to Build

A custom interactive sidebar panel inside VS Code that shows live test results as tests run, with
click-to-view-output behaviour at every level of the test hierarchy.

---

## UI Layout

```
┌─────────────────────────────┬──────────────────────────────┐
│  TEST TREE                  │  OUTPUT                      │
│  [▶ Start] [■ Stop] [↺ Reset]│                              │
│  ─────────────────────────  │  (output for selected item)  │
│  ⟳ auth.test.ts    1200ms   │                              │
│    ⟳ Login Suite            │                              │
│      ✓ logs in   120ms      │                              │
│      ✗ bad pass  80ms       │                              │
│  ✓ utils.test.ts  340ms     │                              │
│    ✓ Helpers                │                              │
│      ✓ formats   20ms       │                              │
└─────────────────────────────┴──────────────────────────────┘
```

### Left pane — Test Tree
- Hierarchy: **File → Suite (describe block) → Test case**
- Each row shows:
  - Status icon: `⟳` spinning (running), `✓` green (passed), `✗` red (failed), `○` grey (skipped)
  - Name of the file / suite / test
  - Duration (ms) right-aligned
- Rows are expandable/collapsible
- Clicking any row updates the right pane with output scoped to that item
- Three toolbar buttons: **Start**, **Stop**, **Reset**

### Right pane — Output
- Shows log output scoped to the clicked item:
  - Click a **file** → all output for that file
  - Click a **suite** → output for tests in that suite
  - Click a **test case** → output for just that test
- ANSI colour rendering (pass/fail colours, Jest output)
- Updates live as tests run

---

## Technical Approach

### Architecture

```
extension.ts
  ├── TestController (keep — native test explorer still works)
  ├── OutputChannel (keep — existing logging)
  └── TestPanelProvider (new WebviewViewProvider)
        ├── Registered as a VS Code WebviewView in the Activity Bar
        ├── Receives test results via postMessage from extension
        └── Sends click events back to extension via postMessage
```

### Two registered views in package.json

| View ID | Location | Purpose |
|---|---|---|
| `liveTestRunner.treeView` | Activity Bar sidebar | Test tree + toolbar buttons |
| `liveTestRunner.outputView` | Panel (bottom) or second sidebar | Output for selected item |

Or alternatively: a **single** WebviewView with an internal split (simpler, but less flexible for
the user to resize independently).

### Message protocol (extension ↔ webview)

**Extension → Webview**
```ts
{ type: 'run-started' }
{ type: 'file-started',  filePath, name }
{ type: 'file-result',   filePath, status, duration, suites: [...] }
{ type: 'test-started',  filePath, suiteName, testName }
{ type: 'test-result',   filePath, suiteName, testName, status, duration, output, failureMessages }
{ type: 'run-finished',  passed, failed, duration }
```

**Webview → Extension**
```ts
{ type: 'select',  scope: 'file'|'suite'|'test', filePath, suiteName?, testName? }
{ type: 'start' }
{ type: 'stop' }
{ type: 'reset' }
```

### Data stored in extension memory

A `Map<string, TestResult>` keyed by a composite ID (`filePath::suiteName::testName`) stores all
results from the current run. When the webview sends a `select` message, the extension looks up the
matching results and replies with the accumulated output lines.

### Output scoping

- **File clicked** → join all output lines for every test in that file
- **Suite clicked** → join all output lines for every test in that suite
- **Test clicked** → output lines for just that test (failure message + Jest stdout for that case)

---

## Files to Create / Modify

| File | Change |
|---|---|
| `src/extension.ts` | Wire up `TestPanelProvider`, forward results to webview |
| `src/TestPanelProvider.ts` | New — WebviewViewProvider class |
| `src/webview/panel.html` | New — HTML/CSS/JS for the tree + output UI |
| `package.json` | Register the new views, add Activity Bar contribution |

Estimated new code: **~350–500 lines** across the new files, plus ~50 lines of changes to
`extension.ts`.

---

## What We Keep

- `TestController` + run profiles → native test explorer, "Run Tests" button in editor gutter all
  still work
- `OutputChannel` → `Live Test Runner (ANSI)` output channel unchanged
- Existing commands (`startTesting`, `stopTesting`, etc.) → wired up to the new toolbar buttons too
- Diagnostics (red squiggles on failures) → unchanged

---

## Phases

### Phase 1 — Core panel (this release)
- [ ] Tree view with file/suite/test hierarchy
- [ ] Live status icons + durations
- [ ] Click-to-view output (scoped)
- [ ] Start / Stop / Reset buttons
- [ ] ANSI colour output in right pane

### Phase 2 — Future
- [ ] Coverage overlay (% per file in tree)
- [ ] Filter bar (show only failures)
- [ ] Re-run single file or single test from the tree
- [ ] Persistent results across window reloads
- [ ] Search within output

---

## Open Questions for Planning Session

1. **Single webview with internal split** vs **two separate registered views**?
   - Single: simpler code, one panel to manage
   - Two separate: user can resize/move each pane independently via VS Code drag

2. **Activity Bar icon** or embed inside the existing Testing sidebar?

3. **Output format** in the right pane: plain ANSI text, or styled HTML (like a mini terminal)?

4. **Auto-expand on run**: should the tree expand automatically when a failure occurs, or stay
   collapsed until the user opens it?

5. **Auto-scroll in output**: scroll to bottom as new output arrives, or keep position?
