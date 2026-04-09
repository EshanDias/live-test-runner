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

### Single source of truth — `ResultStore`

`ResultStore` is the only place where test results live. `LineMap` (inside `ResultStore`) stores only identity references — `{ testId, suiteId, fileId }` — never status or duration.

`DecorationManager` always queries `ResultStore` for status and duration at decoration time. This means decorations are never stale; there is no synchronisation problem.

### Output attribution

The runner reports console output at the **file level only** (this is a Jest/CRA limitation — test runners don't attribute individual `console.log` calls to specific tests). When a file runs, `FileResult.output` is set. Suite and test output are set only when that scope is individually rerun by name pattern.

**Never back-fill.** A test section that was never individually run shows a placeholder — it does not inherit the file-level output. This is correct behaviour, not a limitation.

### Child process isolation

Jest always runs in a child process via `Executor.ts`. The extension host never imports or executes Jest code. This keeps the extension host memory-stable and prevents one failing project from crashing another.

Use `spawn`, never `exec`. `exec` has a buffer limit that silently truncates large outputs. `spawn` streams.

### Session guard

All on-save behavior and CodeLens buttons are session-guarded. Nothing runs in the background. Users explicitly start and stop sessions. This keeps resource usage predictable and prevents surprise background work.

### Debounce on save

On-save runs are debounced at 300ms (configurable). Rapid successive saves (e.g. auto-format on save + manual save) only trigger one run.

### CodeLens registration

The `CodeLensProvider` is registered with `vscode.languages.registerCodeLensProvider` only while a session is active. Disposing the registration removes all lenses from every editor immediately. There is no need to send a "clear lenses" message.

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

## Known limitations

| Limitation | Detail |
|------------|--------|
| `--testNamePattern` may over-match | Rerunning a single test matches by name regex — overlapping names will run together |
| `describe` fallback | If no `LineMap` entry exists for the line, `▶ Run` on a `describe` block reruns the whole file |
| Debug config hardcoded path | `getDebugConfig` in `JestAdapter` uses `${workspaceFolder}/node_modules/.bin/jest`; non-standard layouts may need the `liveTestRunner.jestCommand` override |
| CRA config cache is in-memory | Lost when the session ends; recomputed (~2–3s) on next Start Testing |
| Gutter icon animation | `animateTransform` in the running SVG is rendered statically by VS Code — the spinner does not spin in the gutter |
| `location` not always present | Some Jest setups (CRA, Vitest stub) may not emit `location` in JSON; gutter icons won't appear for those files |

---

## Roadmap

- [ ] Vitest support — `ViteAdapter` stub exists in `packages/runner`; implement `resolveBinary` and `resolveConfig`
- [ ] Suite/test-case level nodes in Test Explorer
- [ ] Disk-persisted CRA config cache (`.vscode/live-test-runner/`)
- [ ] Streaming live output during a run (message type stubbed, not wired)
- [ ] Coverage overlay in the file tree
