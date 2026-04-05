# Live Test Runner — Developer Guide

A VS Code extension for live testing on save. Tests run automatically when you save a file, giving you instant feedback without leaving your editor.

---

## Project Structure

```
packages/
├── core/               # Shared session logic (TestSession, CoverageMap)
├── runner/             # Framework-agnostic runner engine
│   └── src/
│       ├── types.ts                          # Shared enums and result types
│       ├── TestRunner.ts                     # Public interface (all runners implement this)
│       ├── JestRunner.ts                     # Thin orchestrator — wires the layers below
│       ├── framework/
│       │   ├── FrameworkDetector.ts          # Reads package.json → picks the right adapter
│       │   └── adapters/
│       │       ├── FrameworkAdapter.ts       # Interface every adapter must implement
│       │       ├── JestAdapter.ts            # Plain Jest / Next.js + Jest projects
│       │       ├── CRAAdapter.ts             # Create React App (react-scripts)
│       │       └── ViteAdapter.ts            # Vitest stub (not yet supported)
│       ├── resolution/
│       │   └── BinaryResolver.ts             # Finds the jest binary in local node_modules
│       ├── execution/
│       │   └── Executor.ts                   # Spawns Jest, streams stderr, --outputFile strategy
│       └── parsing/
│           └── ResultParser.ts               # Parses Jest JSON output → JestJsonResult
└── vscode-extension/   # The VS Code extension
    └── src/
        ├── extension.ts                      # Entry point — wires instances, registers commands (~110 lines)
        ├── IResultObserver.ts                # Cross-cutting event contract (session/run lifecycle)
        ├── store/
        │   ├── ResultStore.ts                # In-memory File→Suite→Test result tree + LineMap
        │   └── SelectionState.ts             # Selected row tracking; broadcasts scope-changed to webviews
        ├── session/
        │   └── SessionManager.ts             # Session lifecycle, run execution pool, on-save, rerun
        ├── framework/
        │   ├── IFrameworkAdapter.ts          # Adapter interface (detect, runFile, runTestCase, getDebugConfig…)
        │   └── JestAdapter.ts                # All Jest-specific logic — adding Vitest = new file here
        ├── editor/
        │   ├── CodeLensProvider.ts           # ▶ Run / ▷ Debug / ◈ Results CodeLens
        │   └── DecorationManager.ts          # Gutter icons and inline duration text
        ├── views/
        │   ├── BaseWebviewProvider.ts        # Webview lifecycle, postMessage routing, IResultObserver base
        │   ├── ExplorerView.ts               # Sidebar: file/suite/test tree
        │   └── ResultsView.ts                # Panel: detail view with scoped logs and errors
        └── webview/                          # Browser-side assets (not compiled by tsc)
            ├── results.html
            ├── explorer.html
            ├── testListLayout.js             # Shared test list renderer (used by both views)
            └── styles.css
```

---

## Architecture

### Execution flow

```
VS Code saves a file
  → extension.ts onSave
  → SessionManager.onSave
      → IFrameworkAdapter.isTestFile / getAffectedTests
      → SessionManager._runFiles (concurrency pool)
          → IFrameworkAdapter.runFile
              → JestRunner (orchestrator)
                  → FrameworkDetector     detects: jest | cra | vite | …
                  → FrameworkAdapter      resolves binary + config
                  → Executor              spawns jest, captures --outputFile JSON
                  → ResultParser          parses JSON → JestJsonResult
              → JestAdapter._applyFileResult → ResultStore
  → IResultObserver.notify   broadcasts to all observers
      → ExplorerView          pushes full-file-result to sidebar webview
      → ResultsView           pushes full-file-result + scope-logs to panel webview
      → DecorationManager     refreshes gutter icons for visible editors
      → CodeLensProvider      fires onDidChangeCodeLenses
```

### Key design decisions

| Decision | Reason |
|---|---|
| Always use `--outputFile=<tmpfile>` | Avoids Windows pipe-buffering that truncates large JSON on stdout |
| CRA: extract config via `--showConfig`, then run Jest directly | Full ownership of the Jest invocation — `--json`, `--outputFile`, `--no-bail` all work reliably |
| Never run react-scripts or any binary globally | Always resolved from the project's own `node_modules` |
| In-memory config cache (CRA) | `--showConfig` takes ~2-3s; cached per session, invalidated when `package.json` changes |
| `FrameworkAdapter` interface | Adding a new framework = one class + one entry in `ADAPTER_PRIORITY` |
| `TestRunner` interface owns all JSON methods | Extension layer never depends on concrete runner classes |
| `scope-logs` message separate from `scope-changed` | Selection highlight (col 1) and output data (cols 2 & 3) have different lifecycles — keeping them separate avoids double-renders and makes each concern clear |
| Console output stored at run scope, not back-filled | Jest JSON reports console at file level only. Output is attributed to the scope that triggered the run (file/suite/test) and never fabricated for scopes that haven't run. |

### Test Results Panel (3 columns)

The panel is fully custom — no VS Code Test API.

| Column | Content | Driven by |
|--------|---------|-----------|
| 1 — Tests | File/suite/test tree with status, duration, rerun button | `full-file-result` message |
| 2 — Output | Sectioned log output scoped to selected row, filterable by level | `scope-logs` message |
| 3 — Errors | Structured failure entries (test name + message) scoped to selected row | `scope-logs` message |

See [`Plans/v2.1.0-state.md`](Plans/v2.1.0-state.md) for full detail on the scoped output system.

---

## Development Setup

```bash
# Install dependencies
pnpm install

# Start TypeScript watch (extension only)
pnpm start

# Press F5 in VS Code to launch Extension Development Host
```

## Building

```bash
# Build all packages
pnpm run build

# Build individual packages
cd packages/core && pnpm run build
cd packages/runner && pnpm run build
cd packages/vscode-extension && pnpm run compile
```

---

## Adding a New Framework

Adding support for a new test framework (e.g. Vitest, Mocha) requires changes in two places:

### 1. Runner package — how to spawn and parse the framework

Create `packages/runner/src/framework/adapters/VitestAdapter.ts` implementing `FrameworkAdapter`:

```typescript
export class VitestAdapter implements FrameworkAdapter {
  readonly framework: Framework = 'vitest';

  detect(projectRoot: string): boolean {
    // Return true if package.json has vitest
  }

  resolveJestBinary(projectRoot: string): string {
    // Return path to vitest binary in node_modules
  }

  async resolveJestConfig(projectRoot: string): Promise<string | undefined> {
    return undefined; // vitest discovers its own config
  }

  getExtraArgs(projectRoot: string): string[] {
    return [];
  }
}
```

Register it in `FrameworkDetector.ts` in `ADAPTER_PRIORITY`, and export from `packages/runner/src/index.ts`.

### 2. Extension package — how to map results and launch the debugger

Create `packages/vscode-extension/src/framework/VitestAdapter.ts` implementing `IFrameworkAdapter`:

```typescript
export class VitestAdapter implements IFrameworkAdapter {
  async detect(projectRoot) { /* check for vitest in package.json */ }
  async discoverTests(projectRoot, log) { /* ... */ }
  getFileGlob() { return '{**/*.test.*,**/*.spec.*}'; }
  isTestFile(filePath) { return /\.(test|spec)\.[jt]sx?$/.test(filePath); }
  async runFile(store, filePath, projectRoot, log) { /* ... */ }
  async runTestCase(store, filePath, fullName, projectRoot, log, opts) { /* ... */ }
  getAffectedTests(session, changedFile) { /* ... */ }
  getDebugConfig(projectRoot, filePath, testFullName?) { /* vitest debug config */ }
}
```

Then in `extension.ts`, replace `new JestAdapter()` with your adapter (or add auto-detection logic).

`SessionManager`, `ResultStore`, all views, and all observer notifications require zero changes.

---

## Configuration

Settings are defined in `packages/vscode-extension/package.json` under `contributes.configuration.properties`.

| Setting | Default | Description |
|---|---|---|
| `liveTestRunner.projectRoot` | `""` | Override project root (useful for monorepos) |
| `liveTestRunner.jestCommand` | `""` | Override jest binary/command |
| `liveTestRunner.runMode` | `"auto"` | `"auto"` uses resolved binary; `"npm"` delegates to `npm test --` |
| `liveTestRunner.onSaveDebounceMs` | `300` | Debounce delay for on-save runs |

---

## Performance

- Jest runs in a child process — never in the extension host
- Up to 3 test files run concurrently (configurable via `CONCURRENCY` in `extension.ts`)
- On-save execution is debounced
- CRA config extraction is cached in-memory for the session
- Processes are killed immediately on Stop Testing

---

## Publishing

```bash
cd packages/vscode-extension
pnpm run build
vsce package
vsce publish
```

---

## Roadmap

- [ ] Vitest support (`ViteAdapter` stub is already wired — implement `resolveJestBinary` + `resolveJestConfig`)
- [ ] Suite/test-case level Test Explorer nodes
- [ ] Inline diagnostics and squiggles
- [ ] Disk-persisted CRA config cache (`.vscode/live-test-runner/`)

---

## License

MIT
