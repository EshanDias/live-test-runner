# Developer Guide

Everything you need to build, extend, and publish Live Test Runner.

---

## Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- VS Code

---

## Getting started

```bash
git clone https://github.com/eshandias/live-test-runner
cd live-test-runner
pnpm install

# Start TypeScript watch (extension only)
pnpm start

# Press F5 in VS Code to launch the Extension Development Host
```

The Extension Development Host opens a second VS Code window where the extension runs live. Changes to extension source files are picked up after recompilation (watch mode handles this automatically).

---

## Build commands

```bash
# Build all packages
pnpm run build

# Clean rebuild — removes dist/ and .tsbuildinfo files
pnpm run rebuild

# Run all tests
pnpm run test

# Build individual packages
cd packages/core && pnpm run build
cd packages/runner && pnpm run build
cd packages/vscode-extension && pnpm run compile

# Watch mode (extension only)
pnpm start
```

---

## Project layout

```
live-test-runner/
├── README.md               Overview and quick start
├── ARCHITECTURE.md         Full system design and data flow
├── DEVELOPER_GUIDE.md      This file
├── AI_CONTEXT.md           Paste-in doc for AI assistants
├── packages/
│   ├── core/               @live-test-runner/core
│   │   └── README.md
│   ├── runner/             @live-test-runner/runner
│   │   └── README.md
│   └── vscode-extension/   live-test-runner (the extension)
│       ├── README.md       User-facing docs
│       └── DEVELOPER_GUIDE.md  Points to this file
└── pnpm-workspace.yaml
```

---

## Core patterns and practices

### Observer pattern — how results propagate

All result consumers implement `IResultObserver`. `SessionManager` calls every registered observer after each file result. The UI never pulls — it only receives.

```typescript
interface IResultObserver {
  onSessionStart(): void
  onRunStart(filePath: string): void
  onFileResult(result: FileRunResult, store: ResultStore): void
  onSessionStop(): void
}
```

To add a new panel, decoration layer, or any feature that reacts to test results:
1. Create a class implementing `IResultObserver`
2. Instantiate it in `extension.ts`
3. Call `sessionManager.addObserver(instance)`

Nothing else changes.

### Adapter pattern — framework support

Two adapter interfaces exist in the codebase:

- **`FrameworkAdapter`** in `packages/runner/` — handles binary resolution and config extraction. No VS Code dependency.
- **`IFrameworkAdapter`** in `packages/vscode-extension/` — adds VS Code-specific methods (test discovery, debug config, file classification).

The separation means the runner can be used independently of VS Code.

Adding a framework = one class in each package. `SessionManager`, `ResultStore`, all views, and all observers require zero changes.

### Two stores, one source of truth per concern

**`ResultStore`** is the only place where test results live (pass/fail, output, failures). Uses a flat node pool (`Map<string, TestNode>`) with tree relationships via `parentId`/`children`, supporting unlimited nesting. 

- **Node Types**: Supports `suite`, `test`, and `template`.
- **Templates**: Dynamic test headers (`.each`) are `template` nodes. They act as persistent anchors and are never removed by `cleanupStaleNodes` even if they have zero variations.
- **LineMap**: Inside the store; stores only identity references — `{ nodeId, fileId }` — never status or duration. `DecorationManager` always queries `ResultStore.getNode(nodeId)` at decoration time; decorations are never stale.

**`ExecutionTraceStore`** holds three derived indexes built from per-test JSONL trace files:
- `traceIndex` — testId → path to `.jsonl` trace file
- `coverageIndex` — source file → set of line numbers executed (session-accumulated)
- `sourceToTests` — source file → test file → suite → `{ isSharedVars, testCases[] }`

The trace files on disk are the ground truth. The store entries are caches. Rule: **indexes are always rebuilt from trace files, never written independently.** Clear both together on session reset.

`SessionTraceRunner` populates `ExecutionTraceStore` after each file run (fire-and-forget background pass). `SessionManager` reads from it in `_runAffectedBySourceFile` when a source file is saved. Neither store writes to the other.

### Output attribution

The runner reports console output at the **file level only** (this is a Jest/CRA limitation — test runners don't attribute individual `console.log` calls to specific tests). When a file runs, `FileResult.output` is set. Suite and test output are set only when that scope is individually rerun by name pattern.

**Never back-fill.** A test section that was never individually run shows a placeholder — it does not inherit the file-level output. This is correct behaviour, not a limitation.

### Child process isolation

Jest always runs in a child process via `Executor.ts`. The extension host never imports or executes Jest code. This keeps the extension host memory-stable and prevents one failing project from crashing another.

### Multi-Session Isolation (PID-based)

To support multiple concurrent VS Code windows, every extension instance must operate in a strictly isolated temporary directory.

1. **Partitioning**: Session directories are named `session-<pid>-<timestamp>`.
2. **Injection**: All runners and managers receive this directory via constructor injection. NEVER use global temporary constants for file writes.
3. **Safe Cleanup**: On activate, scan the temp root and prune only session folders whose owning PID is inactive (verified via `process.kill(pid, 0)`). 

Use `spawn`, never `exec`. `exec` has a buffer limit that silently truncates large outputs. `spawn` streams.

### Session guard

All on-save behavior and CodeLens buttons are session-guarded. Nothing runs in the background. Users explicitly start and stop sessions. This keeps resource usage predictable and prevents surprise background work.

### Smart on-save reruns

On-save runs are debounced at 300ms (configurable). Rapid successive saves only trigger one run.

When a **source file** (non-test) is saved, the rerun scope is determined by `_runAffectedBySourceFile`:

1. **Trace data available** (after at least one full run): `ExecutionTraceStore.sourceToTests` is queried. For each affected test file, suites with `isSharedVars: false` rerun only their specific affected test cases (single Jest process with a combined `--testNamePattern`). Suites with `isSharedVars: true` rerun the whole file.
2. **No trace data yet**: falls back to `CoverageMap` / `jest --findRelatedTests` and reruns whole test files (same as pre-trace behaviour).

When a **test file** is saved, the whole file always reruns — discovery handles any structural changes.

### Static test discovery

`TestDiscoveryService` runs automatically on extension activate — before the user clicks Start Testing.

- Uses `@babel/parser` + `@babel/traverse` (lazy-loaded from the project's own `node_modules`). No extra dependencies.
- Parses files in batches of 8 with a `setImmediate` yield between batches. Safe on 500+ file projects.
- **Dynamic Anchors**: `discoverTests` identifies `.each` calls and creates `template` nodes. These provide a stable UI target even before Jest runs.
- Calls `store.nodeStarted` / `store.nodeResult` to build the hierarchical node tree — no-ops if the entry already exists so live run results are never overwritten.
- Calls `IResultObserver.onDiscoveryProgress` on every file. Observers are free to ignore it if they don't implement the optional methods.
- `SessionManager.start()` awaits `discovery.awaitDiscovery()` instead of running its own discovery. On a normal project load this is already resolved; it only blocks if Start Testing is clicked during the first discovery pass.

### CodeLens registration

The `CodeLensProvider` is registered with `vscode.languages.registerCodeLensProvider` on extension **activate** — not on session start. Lenses appear as soon as `TestDiscoveryService` populates the first `LineMap` entry. The provider calls `refresh()` on every `onDiscoveryProgress` event so buttons appear incrementally as files are parsed.

---

## Using the Timeline Debugger

The Timeline Debugger runs a single test case through an instrumented Jest transform, records every executed line and variable state, then lets you step through the replay.

**Activate from the editor:**
1. Start a Live Test Runner session (`▶ Start Testing`)
2. Click the `⏱ Timeline` CodeLens that appears above any `it()` or `test()` line

**Activate from the sidebar:**
- Click the `⏱` button on any test row in the Explorer sidebar

On activation the Results panel switches to Timeline mode and a loading spinner appears while the trace runs. When complete:

- The **timeline bar** shows one box per executed step. Click any box or use the playback controls (`⏮ ◀ ▶ ▶| ⏭ ⏸`) to step through.
- The **editor** highlights the active line and shows variable values as ghost text inline.
- The **sidebar** shows State (variables at the current step), Watch (pin variables), and Call Stack.
- The **Console** and **Errors** tabs in the right column show logs and failures.

**Zoom:** scroll the mouse wheel over the timeline bar to zoom between line / function / file grouping levels.

**Re-run:** click the `↺ Re-run` button in the sidebar header to run the trace again.

**Exit:** click any normal test row in the sidebar to return to normal mode. All timeline decorations are cleared.

---

## Adding a new instrumented framework

The Timeline Debugger uses `IInstrumentedRunner` as its framework boundary. Adding Vitest or Mocha timeline support = one new file. Nothing else changes.

```typescript
// packages/vscode-extension/src/timeline/VitestInstrumentedRunner.ts
import { IInstrumentedRunner } from './IInstrumentedRunner'
import { TimelineStore } from './TimelineStore'

export class VitestInstrumentedRunner implements IInstrumentedRunner {
  async run(options: { filePath: string; testFullName: string; projectRoot: string }): Promise<TimelineStore> {
    // 1. Create a temp file for JSONL trace output
    // 2. Configure Vitest to load your instrumentation transform
    // 3. Spawn Vitest via Executor or directly
    // 4. Parse the JSONL trace into a TimelineStore (reuse parseEvents logic)
    // 5. Return the store
  }

  cancel(): void { /* kill the child process */ }
}
```

In `extension.ts`, swap `new JestInstrumentedRunner()` for `new VitestInstrumentedRunner()` — or add auto-detection logic based on the project root.

**Key files to understand:**
- `timeline/instrumentation/traceTransform.js` — the Jest regex-based transform (adapt for Vitest's transform API)
- `timeline/instrumentation/traceRuntime.js` — the `__trace` runtime (reuse as-is — it just writes JSONL)
- `timeline/JestInstrumentedRunner.ts` — the full Jest implementation to follow as a reference

---

## Adding a new framework

Supporting Vitest, Mocha, or any other framework requires one class in each of two packages. No other files change.

### Step 1 — Runner package

Create `packages/runner/src/framework/adapters/VitestAdapter.ts`:

```typescript
import { FrameworkAdapter } from './FrameworkAdapter'
import { Framework } from '../../types'
import * as fs from 'fs'
import * as path from 'path'

export class VitestAdapter implements FrameworkAdapter {
  readonly framework: Framework = 'vitest'

  detect(projectRoot: string): boolean {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    return !!(pkg.dependencies?.vitest || pkg.devDependencies?.vitest)
  }

  resolveBinary(projectRoot: string): string {
    return path.join(projectRoot, 'node_modules', '.bin', 'vitest')
  }

  async resolveConfig(projectRoot: string): Promise<string | undefined> {
    return undefined  // vitest discovers its own config
  }

  getExtraArgs(projectRoot: string): string[] {
    return []
  }
}
```

Register it in `FrameworkDetector.ts`:

```typescript
const ADAPTER_PRIORITY: FrameworkAdapter[] = [
  new CRAAdapter(),
  new VitestAdapter(),  // add before JestAdapter
  new JestAdapter(),
]
```

Export from `packages/runner/src/index.ts`.

### Step 2 — Extension package

Create `packages/vscode-extension/src/framework/VitestAdapter.ts`:

```typescript
export class VitestAdapter implements IFrameworkAdapter {
  async detect(projectRoot: string): Promise<boolean> { ... }

  async discoverTests(projectRoot: string, log: OutputChannel): Promise<string[]> {
    // run vitest --listTests equivalent
  }

  getFileGlob(): string {
    return '{**/*.test.*,**/*.spec.*}'
  }

  isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.[jt]sx?$/.test(filePath)
  }

  async runFile(store: ResultStore, filePath: string, projectRoot: string, log: OutputChannel): Promise<void> { ... }

  async runTestCase(store: ResultStore, filePath: string, fullName: string, projectRoot: string, log: OutputChannel): Promise<void> { ... }

  getAffectedTests(session: TestSession, changedFile: string): string[] { ... }

  getDebugConfig(projectRoot: string, filePath: string, testFullName?: string): DebugConfiguration {
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Vitest',
      program: path.join(projectRoot, 'node_modules', '.bin', 'vitest'),
      args: [filePath, '--testNamePattern', testFullName ?? ''],
      cwd: projectRoot,
      console: 'integratedTerminal',
    }
  }
}
```

Update `extension.ts` to instantiate `VitestAdapter` or add auto-detection logic.

---

## Adding a new observer (panel, decoration, etc.)

1. Implement `IResultObserver` from `src/IResultObserver.ts`
2. Instantiate in `extension.ts`
3. `sessionManager.addObserver(instance)`

The observer receives:
- `onSessionStart()` — session began
- `onRunStart(filePath)` — a file started running
- `onFileResult(result, store)` — a file's results are available
- `onSessionStop()` — session ended

Read from `ResultStore` to get any data you need. Never cache a copy of result data in your observer — query the store at use time.

---

## Webview communication

Webviews communicate with the extension host via `postMessage`. The routing is in `BaseWebviewProvider._onMessage()`.

**Extension → webview:**
```typescript
this._panel.webview.postMessage({ type: 'full-file-result', payload: { ... } })
```

**Webview → extension:**
```javascript
window.vscode.postMessage({ type: 'rerun', payload: { filePath } })
```

Rules:
- Use distinct `type` strings. Never infer intent from payload shape.
- `scope-logs` and `scope-changed` are always sent separately — they have different lifecycles.
- `full-file-result` drives column 1 on every run.
- `scope-logs` drives columns 2 and 3 only when selection changes or a run completes for the selected scope.

---

## Duration thresholds

Thresholds are per-level and user-configurable. The logic lives in two places:

- `src/utils/duration.ts` — TypeScript; used by `DecorationManager` and passed to webviews via the `init` message
- `src/webview/utils.js` — plain JS mirror; exposes `window.LiveTestUtils`; used inside the webview sandbox

The extension reads thresholds via `getThresholds()` on session start and sends them in the `init` message. Webviews call `LiveTestUtils.setThresholds(msg.thresholds)` on receipt.

Never hardcode thresholds in the webview. Always use `LiveTestUtils`.

---

## Configuration

All user settings are in `packages/vscode-extension/package.json` under `contributes.configuration.properties`.

Read in extension code:
```typescript
const config = vscode.workspace.getConfiguration('liveTestRunner')
const debounce = config.get<number>('onSaveDebounceMs', 300)
```

Do not hardcode defaults in extension code — always read from config with a sensible fallback so users can override.

### `runMode` — npm test integration

`liveTestRunner.runMode` controls how tests are invoked:

| Value | Behaviour |
|-------|-----------|
| `"auto"` (default) | Extension resolves Jest directly and calls it with `--json --outputFile --no-bail --testLocationInResults`. Full structured output: per-test durations, console capture, gutter icons, scope-level reruns, `◈ Results`. |
| `"npm"` | Extension delegates to `npm test --`. Works for projects where the Jest binary is wrapped or the test script is non-standard. **Limitation:** the extension appends `--json` but cannot guarantee `npm test` passes it through unchanged. Per-test durations, console capture, and `location` data may be absent or degraded. `jestCommand` is ignored in this mode. |

Handled in `JestAdapter._getCommand()` — returns `"npm test --"` when `runMode` is `"npm"`, otherwise returns `jestCommand` (or empty string for auto-detection).

---

## Publishing

```bash
cd packages/vscode-extension
pnpm run build
vsce package     # produces a .vsix file for testing
vsce publish     # publishes to VS Code Marketplace
```

Before publishing:
1. Bump the version in `packages/vscode-extension/package.json`
2. Update `CHANGELOG.md`
3. Run `pnpm run build` from the root to verify everything compiles

---

## Testing

Run all tests:
```bash
pnpm run test
```

Per-package:
```bash
cd packages/runner && pnpm run test
```

**Runner tests:** test adapters with a real fixture project root so the adapter resolves real binaries. Test `ResultParser` against saved Jest JSON output files — keeps parsing logic testable without spawning Jest.

**Extension tests:** mock VS Code APIs using VS Code's test harness. Test `ResultStore` independently — it has no VS Code dependencies.

---

## Core patterns (Timeline Debugger additions)

### Webview router pattern

Both `ResultsView` and `ExplorerView` implement an internal single-page router (`router.js`). The router listens for `{ type: 'route', view: '...' }` messages and swaps view modules in and out of `<div id="app">`.

Each view module exports `{ mount(container, vscode, payload), unmount(), onMessage(msg) }`. Adding a new view = one new JS file + one entry in the `views` map passed to `Router.init()` in the HTML shell.

### `PlaybackEngine` pattern

`PlaybackEngine` is a plain JS class that lives in the webview (`src/webview/timeline/PlaybackEngine.js`). It owns all playback state (`currentStepId`, play/pause timer). Callers wire callbacks — the engine emits nothing itself. To use it:

```javascript
const engine = new PlaybackEngine(store)  // store has .steps array
engine.play(step => { /* update UI, call vscode.postMessage step-changed */ })
engine.pause()
engine.jumpTo(stepId)
```

### Shared component pattern

`logPanel.js` and `errorPanel.js` in `src/webview/components/` are standalone JS modules loaded as `<script>` tags in both HTML shells. They expose `window.LogPanel` and `window.ErrorPanel` with `{ mount, update, unmount }`. Views call these directly — no import/export, no bundler required.

---

## Known limitations

| Limitation | Detail |
|------------|--------|
| `--testNamePattern` may over-match | Rerunning a single test matches by name regex — overlapping names will run together |
| `describe` fallback | If no `LineMap` entry exists for the line, `▶ Run` on a `describe` block reruns the whole file |
| Debug config hardcoded path | `getDebugConfig` in `JestAdapter` uses `${workspaceFolder}/node_modules/.bin/jest`; non-standard layouts may need the `liveTestRunner.jestCommand` override |
| CRA config cache is in-memory | Lost when the session ends; recomputed (~2–3s) on next Start Testing |
| Gutter icon animation | `animateTransform` in the running SVG is rendered statically by VS Code — the spinner does not spin in the gutter |
| `location` not always present | Some Jest setups (CRA, Vitest stub) may not emit `location` in JSON; gutter icons won't appear for those files |
| Timeline transform: regex-based injection | `traceTransform.js` injects trace calls using Babel AST. It handles assignments, function calls, and common statement patterns, but may miss complex patterns such as multi-line destructuring or chained optional calls inside expressions. |
| Timeline: no import tracing | The transform only instruments the target test file. Imported modules are not traced; their execution does not appear as steps in the timeline. |
| Timeline: `console.log` in tests | `traceRuntime.js` patches `console.*` to emit LOG events. If the test patches `console` before the runtime loads, log capture may be incomplete. |

---

## Roadmap

- [ ] Vitest support — `ViteAdapter` stub exists in `packages/runner`; implement `resolveBinary` and `resolveConfig`
- [x] ~~Suite/test-case level nodes in Test Explorer~~ — completed in 1.2.0 (recursive node tree with unlimited nesting)
- [ ] Disk-persisted CRA config cache (`.vscode/live-test-runner/`)
- [ ] Streaming live output during a run (message type stubbed, not wired)
- [ ] Coverage overlay in the file tree
- [ ] Monorepo multi-root support — multiple `TestDiscoveryService` instances, one per root
