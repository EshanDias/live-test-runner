# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Quick Commands

```bash
# Development
pnpm install              # Install dependencies
pnpm start               # Watch mode (extension only); then press F5 in VS Code
pnpm build               # Build all packages
pnpm rebuild             # Clean rebuild (remove dist/, out/, .tsbuildinfo)

# Testing
pnpm test                # Run all tests
pnpm test -- --watch     # Run tests in watch mode

# Linting
pnpm lint                # Lint all packages

# Individual package builds
cd packages/core && pnpm run build
cd packages/runner && pnpm run build
cd packages/vscode-extension && pnpm run compile
```

**Development workflow:**
1. Run `pnpm start` to start TypeScript watch mode for the extension
2. Press **F5** in VS Code to launch the Extension Development Host
3. Changes to extension source are picked up automatically after recompilation

---

## Architecture Overview

Live Test Runner is a **monorepo of three packages** forming a layered system:

```
packages/
├── runner/            @live-test-runner/runner
│   └── Framework-agnostic test execution engine (no VS Code dependency)
├── core/              @live-test-runner/core
│   └── Session lifecycle + coverage map (depends on runner)
└── vscode-extension/  live-test-runner
    └── VS Code UI (depends on core)
```

**Critical rule**: Dependency direction is strict — `vscode-extension` → `core` → `runner`. Never introduce circular dependencies or have runner/core depend on VS Code APIs.

---

## Key Architectural Patterns

### 1. Observer Pattern — Result Propagation

All UI components and features implement `IResultObserver`:

```typescript
interface IResultObserver {
  onSessionStart(): void
  onRunStart(filePath: string): void
  onFileResult(result: FileRunResult, store: ResultStore): void
  onSessionStop(): void
}
```

**Pattern**: Results flow in one direction — `SessionManager` → observers. **Never pull results from the manager; only observe them.** New features (decorations, panels, timeline) are added by:
1. Implementing `IResultObserver`
2. Instantiating in `extension.ts` and calling `sessionManager.addObserver(instance)`

No other changes needed.

### 2. Adapter Pattern — Framework Support

Two interfaces manage framework abstraction:

- **`FrameworkAdapter`** (`packages/runner/`) — binary resolution, config extraction. No VS Code dependency.
- **`IFrameworkAdapter`** (`packages/vscode-extension/`) — adds VS Code-specific logic (test discovery, debug config, file classification).

Adding a framework = one class in each package. `SessionManager`, `ResultStore`, views, and observers require zero changes.

### 3. Two Stores, One Source of Truth Per Concern

**`ResultStore`** — the only place test results live (pass/fail, output, failures).
- Flat node pool: `Map<string, TestNode>` with tree structure via `parentId`/`children`
- Supports unlimited nesting
- **Templates**: Dynamic test headers (`.each`) are `template` nodes; they persist even with zero variations
- **LineMap**: stores only identity (`{ nodeId, fileId }`), never status. Decorations always query `ResultStore.getNode()` at render time

**`ExecutionTraceStore`** — derived indexes built from per-test JSONL trace files:
- `traceIndex` — testId → path to `.jsonl` trace file
- `coverageIndex` — source file → executed line numbers
- `sourceToTests` — source file → test file → suite → test metadata

**Rule**: Indexes are rebuilt from trace files on every session reset. Trace files on disk are ground truth.

### 4. Multi-Session Isolation (PID-based)

Each extension instance operates in an isolated temporary directory to support multiple concurrent VS Code windows:

1. Session dirs: `session-<pid>-<timestamp>`
2. All runners/managers receive this directory via constructor injection
3. On activation, scan temp root and prune session folders with inactive PIDs

**Rule**: Use `spawn()`, never `exec()`. `exec()` has a buffer limit; `spawn()` streams.

### 5. Child Process Isolation

Jest always runs in a spawned child process (`Executor.ts`). The extension host never imports or executes Jest code. This keeps extension host memory stable and prevents one failing project from crashing another.

### 6. Smart On-Save Reruns

After the first full run, saving a source file triggers targeted test reruns via `jest --findRelatedTests` or the coverage map. Suite/test-level execution uses name patterns to isolate scope. This is implemented in `SessionManager._runAffectedBySourceFile()`.

### 7. Session Guard

All on-save behavior and CodeLens buttons are session-guarded. Nothing runs in the background; users explicitly start/stop sessions. This keeps resource usage predictable.

### 8. Output Attribution

Jest reports console output at the **file level only** (test runner limitation — individual console calls are not attributed to specific tests). Suite and test output exist only when that scope is individually rerun by name pattern.

**Never back-fill**: A test section never individually run shows a placeholder, not inherited file output. This is correct behavior.

---

## Why a Custom UI?

VS Code's native Test Results panel has a Mac-specific bug: clicking an individual test shows "The test case did not report any output" even when output is appended correctly. This is a VS Code API limitation.

Solution: fully custom webview UI. Gives cross-platform control and enables Wallaby-style editor integration that the VS Code API cannot support.

---

## VS Code Layout & Zones

```
┌──────┬────────────────────────────────────────────┐
│      │                                            │
│  A   │              Editor area                  │
│  c   │    (gutter icons, inline duration,        │
│  t   │     CodeLens ▶ Run  ▷ Debug  ◈ Results)   │
│  i   ├────────────────────────────────────────────│
│  v   │            Panel (bottom)                  │
│  i   │  [ Output ]  [ Test Results ]              │
│  t   │                                            │
│  y   ├────────────────────────────────────────────┤
│      │  Status Bar                                │
└──────┴────────────────────────────────────────────┘
  │  Primary sidebar: Live Test Runner (explorer view)
```

| Zone | Content |
|------|---------|
| **Activity Bar** | Beaker icon → opens Explorer view |
| **Primary sidebar** | **Explorer view** (file → node tree with search); switches to **Timeline sidebar** (State/Watch/Call Stack) in timeline mode |
| **Panel › Output** | Raw output channel (every Jest command, full stderr, unformatted ANSI) |
| **Panel › Test Results** | **Results view** (3-column: test list, output, errors) in normal mode; **Timeline view** (bar + controls + console) in timeline mode |
| **Editor gutter** | Status icons (✓ / ✗ / ⟳ / ○) per test line; active-step highlight in timeline mode |
| **Editor inline** | Duration text after each test (normal mode); variable ghost text at current step (timeline mode) |
| **Editor CodeLens** | `▶ Run`, `▷ Debug`, `◈ Results`, `⏱ Timeline` above each block |
| **Status Bar** | Live summary: `Live Tests: ✅ 12 passed` |

---

## Package Details

### `packages/runner` — Test Execution Engine

Layered architecture:

```
JestRunner (orchestrator)
  ├── FrameworkDetector     inspects package.json → picks adapter
  ├── FrameworkAdapter      binary + config resolution
  ├── BinaryResolver        finds jest in node_modules
  ├── Executor              spawns Jest, reads --outputFile JSON on exit
  └── ResultParser          normalises JSON → RunResult
```

Each `FrameworkAdapter` implements:
- `detect(projectRoot)` — returns true if handles this project
- `resolveBinary(projectRoot)` — absolute path to test binary
- `resolveConfig(projectRoot)` — path to config or undefined
- `getExtraArgs(projectRoot)` — extra CLI flags

Current adapters: Jest, Create React App.

### `packages/core` — Session Lifecycle & Coverage

| File | Responsibility |
|------|---|
| `TestSession.ts` | Start, stop, reset a session |
| `CoverageMap.ts` | `Map<SourcePath, Set<TestPath>>` built during warm-up run, updated incrementally |
| `SelectionPolicy.ts` | Legacy; minimal use |

**Coverage map** is built once during full suite run with coverage, then incremented on each on-save run. When a source file is saved, the map is checked before falling back to `jest --findRelatedTests`.

### `packages/vscode-extension` — VS Code Extension

Key directories:

| Dir | Purpose |
|-----|---------|
| `src/extension.ts` | Entry point; instantiates all managers and observers |
| `src/session/` | `SessionManager`, `SessionTraceRunner`, trace runtime/transform |
| `src/editor/` | `DecorationManager`, CodeLens |
| `src/views/` | Explorer view, Results view, Timeline view |
| `src/store/` | `ResultStore`, `ExecutionTraceStore` |
| `src/timeline/` | Timeline Debugger (step-through replay, variable inspection) |
| `src/framework/` | `IFrameworkAdapter` implementations |
| `src/webview/` | Webview UI bundles (HTML, CSS, JS) |

---

## Important Behavioral Rules

1. **No circular dependencies** — runner/core must never depend on VS Code
2. **Always spawn, never exec** — `exec()` buffers and truncates large outputs
3. **Session-guarded behavior** — on-save and CodeLens only work when session is active
4. **Never back-fill output** — unrun test scopes show placeholders, not inherited file output
5. **Indexes rebuild on reset** — trace files are ground truth; indexes are derived caches
6. **Lazy initialization** — results are never pre-fetched; observers are called when results are ready
7. **Per-scope output** — only rerun the scope explicitly requested (test name pattern isolation)

---

## Testing & Debugging

Run tests for all packages:
```bash
pnpm test
pnpm test -- --watch
```

For individual package:
```bash
cd packages/runner && pnpm test
```

**Debug the extension:**
1. Run `pnpm start` to watch extension source
2. Press F5 to open Extension Development Host
3. Open a project with Jest tests
4. Set breakpoints in source files and they'll hit in the dev host
5. Use Developer Tools (Ctrl+Shift+I) to inspect webview UIs

---

## Documentation Maintenance

When making changes, update the relevant documentation files:

| Change Type | Update These Files |
|---|---|
| **Architecture or system design changes** | `docs/architecture.md`, `docs/ai-context.md` |
| **Core package API or lifecycle changes** | `packages/core/README.md`, `docs/developer-guide.md`, `docs/ai-context.md` |
| **Runner package API, layer changes, or framework adapter updates** | `packages/runner/README.md`, `docs/developer-guide.md`, `docs/ai-context.md` |
| **Extension features, UI changes, new commands, or configuration options** | `packages/vscode-extension/README.md` (marketplace-facing), `CHANGELOG.md`, `docs/ai-context.md` |
| **Dev setup, build process, or development patterns** | `docs/developer-guide.md`, `CLAUDE.md` |
| **User-facing fixes or feature releases** | `packages/vscode-extension/CHANGELOG.md`, `packages/vscode-extension/README.md` |

**For README.md (marketplace-facing):** If you need user input to complete the documentation (e.g., user feedback, testing results, specific requirements), add a `[TODO: USER_INPUT_NEEDED]` placeholder with a brief description of what's needed. Keep the existing content and structure.

---

## References

- [docs/architecture.md](docs/architecture.md) — Full system design, data flow, UI details, key decisions
- [docs/developer-guide.md](docs/developer-guide.md) — Dev setup, core patterns, adding frameworks, publishing
- [docs/ai-context.md](docs/ai-context.md) — Complete AI context for full codebase understanding
- [packages/core/README.md](packages/core/README.md) — Core API and design
- [packages/runner/README.md](packages/runner/README.md) — Runner API, layers, CRA behavior
- [packages/vscode-extension/README.md](packages/vscode-extension/README.md) — User guide and features (marketplace-facing)
