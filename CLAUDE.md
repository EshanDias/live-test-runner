# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Quick Commands

```bash
# Development
pnpm install              # Install dependencies (pnpm version pinned via packageManager)
pnpm start               # Watch mode (extension only); then press F5 in VS Code
pnpm build               # Build all packages
pnpm rebuild             # Clean rebuild (remove dist/, out/, .tsbuildinfo)

# Testing
pnpm test                # Unit tests (runner + extension store/helpers)
pnpm test -- --watch     # Run tests in watch mode
node e2e/run.js --all    # End-to-end: real VS Code + real Jest (build first; also runs in CI on Win/Linux/macOS)
node e2e/run.js basic-stop basic-hang      # selected scenarios
# Real projects (optional): LTR_E2E_TSJEST_REPO, LTR_E2E_CRA_REPO (+ LTR_E2E_CRA_FULL=1)
node e2e/real-repos.js   # real-repo matrix on read-only copies (--all incl. the heavy jest monorepo)

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
2. Instantiating in `extension.ts` and adding it to the `observers` array passed to `SessionManager`

No other changes needed.

### 2. Adapter Pattern — Framework Support

Two interfaces manage framework abstraction:

- **`FrameworkAdapter`** (`packages/runner/`) — binary resolution, config extraction. No VS Code dependency.
- **`IFrameworkAdapter`** (`packages/vscode-extension/`) — adds VS Code-specific logic (test discovery, debug config, file classification).
- **`FrameworkServices`** (`packages/vscode-extension/src/framework/FrameworkServices.ts`) — the extension-side bundle per framework: `adapter`, `projectConfig` (`IProjectConfig`), `batchRunner` (`IBatchRunner`), `instrumentedRunner`, `createSessionRunner()`. `SessionManager` gets an `IFrameworkServicesProvider` and asks `servicesFor(fileOrRoot)`; it never constructs framework classes. `extension.ts` composes a `DetectingFrameworkProvider` (Jest bundle `createJestServices` or Vitest bundle `createVitestServices`, per project root). Both extension adapters extend `RunnerBackedAdapter`.

Adding a framework = one adapter in each package + its services bundle. `SessionManager`, `ResultStore`, views, and observers require zero changes.

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

On-save reruns are session-guarded: nothing runs in the background until the user clicks Start, and Stop is final (no further batch, retry or fallback starts). Explicit clicks — CodeLens `▶ Run` / `▷ Debug`, rerun buttons — work without a session, because the user asked for exactly that run. This keeps resource usage predictable.

### 8. Output Attribution

Jest reports console output at the **file level only** (test runner limitation — individual console calls are not attributed to specific tests). Suite and test output exist only when that scope is individually rerun by name pattern.

Vitest attributes every console call to the test or suite that made it (our reporter, `onUserConsoleLog`): `ConsoleEntry.scope` / `scopeName` are set, and every test that ran gets exactly its own lines (possibly none), suites their hooks' lines, the file all lines. That is attribution, not back-fill.

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
| **Panel › Output** | **Live Test Runner** — levelled extension log · **Live Test Runner: Test Output** — raw Jest output (ANSI-stripped, `[jest#N]`-tagged) |
| **Panel › Test Results** | **Results view** (3-column: test list, output, errors) in normal mode; **Timeline view** (bar + controls + console) in timeline mode |
| **Editor gutter** | Status icons (✓ / ✗ / ⟳ / ○) per test line; active-step highlight in timeline mode |
| **Editor inline** | Duration text after each test (normal mode); variable ghost text at current step (timeline mode) |
| **Editor CodeLens** | `▶ Run`, `▷ Debug`, `◈ Results` above each block (the Timeline opens from the Results panel) |
| **Status Bar** | Live summary: `Live Tests: ✅ 12 passed` |

---

## Package Details

### `packages/runner` — Test Execution Engine

Layered architecture:

```
CommandRunner (generic orchestrator: binary/config/extra args, chunking, kill, coverage)
  └── JestRunner            Jest flags only — buildArgs(RunRequest)
        ├── FrameworkDetector     inspects package.json → picks adapter
        ├── FrameworkAdapter      binary + config resolution, result-file flag, JSON parser
        ├── BinaryResolver        finds jest in node_modules
        ├── Executor              spawns the runner, reads its result file on exit
        └── ResultParser          normalises Jest JSON → RunResult
```

Each `FrameworkAdapter` implements:
- `detect(projectRoot)` — returns true if handles this project
- `resolveBinary(projectRoot)` — absolute path to test binary
- `resolveConfig(projectRoot)` — path to config or undefined
- `getExtraArgs(projectRoot)` — extra CLI flags
- `outputFileArg(file)` / `parseResult(passed, raw, stderr)` — where the JSON result goes and how it is read
- `createRunner(options)` — the framework's `TestRunner`

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
| `src/session/` | `SessionManager`, `JestBatchRunner`, trace runtime/transform |
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
3. **Session-guarded behavior** — on-save reruns only run while a session is active; explicit CodeLens / rerun clicks always run
4. **Never back-fill output** — unrun test scopes show placeholders, not inherited file output
5. **Indexes rebuild on reset** — trace files are ground truth; indexes are derived caches
6. **Lazy initialization** — results are never pre-fetched; observers are called when results are ready
7. **Per-scope output** — only rerun the scope explicitly requested (test name pattern isolation)
8. **Log through the logger** — `logger.scope('Area')` (extension), `createLogger('Area')` (runner/core), `[LTR:<level>] msg` on stderr (instrumentation inside Jest). Never `console.*`, never extension messages in the Test Output channel. ERROR = broken, WARN = degraded/fallback, INFO = one line per user action/run, DEBUG/TRACE = details. See `docs/developer-guide.md` → Logging.

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

## Git Workflow & Branching

**Never do any work on `main`.** Always create a branch first, then do the work there.

| Branch prefix | Purpose | Created from | PR target |
|---|---|---|---|
| `release/<version>` | Collects a batch of changes for one release (e.g. `release/2.1.0`) | `main` | `main` |
| `feat/*` | New features | `main`, a `release/*`, or another `feat/*` | a `release/*` or the parent `feat/*` |
| `bugfix/*` | Bug fixes | `feat/*`, `release/*` or `main` | the `feat/*` or `release/*` it was branched from |
| `hotfix/*` | Urgent production fixes | `main` | `main`, or a `release/*` |

Rules:
1. Branch names must start with `release/`, `feat/`, `hotfix/` or `bugfix/`.
2. **No direct pushes or merges to `main` or `release/*`.** Everything lands through a pull request.
3. `main` only accepts PRs from `release/*` (normal flow) and `hotfix/*` (urgent fixes).
4. `release/*` accepts PRs from `feat/*`, `bugfix/*` and `hotfix/*`.
5. `bugfix/*` PRs only target a `feat/*` or `release/*` branch, never `main`.
6. Feature branches may branch off other feature branches and PR back into that feature or into a `release/*`.
7. **PRs must fail if tests fail** (`pnpm test`).
8. **PRs to `main` must fail if the version has not been bumped.** Bump the version in the `release/*` branch (root and `packages/vscode-extension/package.json`) along with the changelogs.
9. **Merging to `main` triggers the release pipeline** (`.github/workflows/release.yml`): build, test, publish, and only on success create the `vX.Y.Z` tag and GitHub Release. Never create release tags by hand.

When asked to make a change while on `main` or `release/*`, create the appropriately named branch before editing anything. Never push or merge to either from a local checkout.

Enforcement: `.github/workflows/pr-checks.yml` validates branch names/targets, runs tests, and checks the version bump on PRs to `main`. It must be paired with GitHub branch protection on `main` and `release/*` (require PR, require the checks `Branch rules`, `Tests`, plus `Version bump (PRs to main)` on `main`, block direct pushes) — see `docs/developer-guide.md`.

---

## Documentation Maintenance

When making changes, update the relevant documentation files:

**Changelogs:**
- `CHANGELOG.md` (root) — complete record of all changes across the repo; include every meaningful change here
- `packages/vscode-extension/CHANGELOG.md` — user-facing only; short, plain-language summary of what's new or different in the extension (what users care about)

| Change Type | Update These Files |
|---|---|
| **Architecture or system design changes** | `docs/architecture.md`, `docs/ai-context.md` |
| **Core package API or lifecycle changes** | `packages/core/README.md`, `docs/developer-guide.md`, `docs/ai-context.md` |
| **Runner package API, layer changes, or framework adapter updates** | `packages/runner/README.md`, `docs/developer-guide.md`, `docs/ai-context.md` |
| **Extension features, UI changes, new commands, or configuration options** | `packages/vscode-extension/README.md` (marketplace-facing), `CHANGELOG.md`, `docs/ai-context.md` |
| **Dev setup, build process, or development patterns** | `docs/developer-guide.md`, `CLAUDE.md` |
| **Any user-visible change (features, fixes, behaviour)** | `CHANGELOG.md` (full detail) + `packages/vscode-extension/CHANGELOG.md` (brief user summary) |
| **Anything important for users or contributors** (new feature, setting, command, framework support, changed behaviour, known limitation) | `docs/live-test-runner-guide.html` (the guide — published at `/guide/` and shown by **Open Guide**) |
| **Headline features, supported frameworks, install / review links** | `site/index.html` (landing page) — and bump `lastmod` in `site/sitemap.xml` |

**For the HTML pages (`site/index.html`, `docs/live-test-runner-guide.html`):**
- Keep them in step with the README and the changelogs — if a change is worth a README line, it is worth a guide update.
- Every link that leaves the current page (external URLs, and the site's links to the guide) opens in a new tab: `target="_blank" rel="noopener"`. Only in-page `#anchor` links and the site's own home link stay in the same tab.

**For README.md (marketplace-facing):**
- Keep it **short and scannable** — users should understand what they get at a glance. Prefer bullet points and short tables over paragraphs. Cut any text that isn't immediately useful to a new user.
- If a new feature needs a gif, screenshot, or video to show it off, add a `<!-- [TODO: USER_INPUT_NEEDED] description of what's needed -->` comment placeholder at the right spot. Do not skip the placeholder — visuals are required for marketplace-facing docs.
- If you need user input for any other reason (testing results, specific requirements), also use a `[TODO: USER_INPUT_NEEDED]` placeholder.

---

## References

- [docs/architecture.md](docs/architecture.md) — Full system design, data flow, UI details, key decisions
- [docs/developer-guide.md](docs/developer-guide.md) — Dev setup, core patterns, adding frameworks, publishing
- [docs/ai-context.md](docs/ai-context.md) — Complete AI context for full codebase understanding
- [docs/bugs-and-issues.md](docs/bugs-and-issues.md) — Known bugs with root-cause analysis and suggested fixes
- [docs/live-test-runner-guide.html](docs/live-test-runner-guide.html) — User & contributor guide (open in a browser; published at `/guide/`)
- [site/index.html](site/index.html) — Marketing landing page + `sitemap.xml` (GitHub Pages, see developer guide → Website)
- [packages/core/README.md](packages/core/README.md) — Core API and design
- [packages/runner/README.md](packages/runner/README.md) — Runner API, layers, CRA behavior
- [packages/vscode-extension/README.md](packages/vscode-extension/README.md) — User guide and features (marketplace-facing)
