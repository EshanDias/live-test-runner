# Vitest Support & Framework Decoupling — Task Plan (release 3.0.0)

> Working document. Tasks are worked top to bottom; tick the box in the
> [Progress tracker](#progress-tracker) when a task is done. Estimates are
> *focused working days including tests and docs*, ±30 %.

## 0. Decisions (from the owner)

| # | Decision |
|---|---|
| D1 | 2.0.4 is released; `release/3.0.0` is cut from `main`. Features are built on `feat/*` branches cut from the release branch and PR'd back into it. |
| D2 | Vitest ≥ 3 is the supported baseline (all owner test projects are ≥ 4). Versions < 3 are supported only where it is cheap (capability-gated, see 2.1). |
| D3 | **3.0.0 target = one project, Vitest, tests + pass/fail + logs + code coverage.** Everything else ships as patches/minors afterwards. |
| D4 | Timeline debugger (Jest and Vitest) is deferred; not in 3.0.0. |
| D5 | Monorepo / multi-project workspace support comes **before** mixed-framework support. |
| D6 | Mixed-framework projects are a later bonus feature, built only after monorepo support is confirmed. |
| D7 | Every feature PR updates a **framework feature matrix** (README table) and the HTML guide. |
| D8 | Real Vitest test projects live in `/Users/eshandias/Projects/test/vitest-projects` (read-only, like the Jest ones). |
| D9 | (2026-10-22) Work continues through phases 5.3 → 11 → 6 → 7 → 8 → 9, one `feat/*` branch per phase, chained on the previous one; every branch is committed and pushed to origin — **no PRs are opened by the agent**, the owner opens/merges them. Phase 10 (Vitest Timeline) is **out of scope** — a separate later release (the Jest timeline does not do what the owner needs either). |
| D10 | (Q5) The HTML guide is published with GitHub Pages, linked from the README, and an "Open Guide" command opens it — task 11.4, part of 3.0.0. |
| D11 | Monorepos (phase 7): every project in the workspace is **detected, none is run** automatically. A **project switcher row at the top of the Explorer** (`name ▾ ● running ✓120 ✗2`) lists all projects with their live state; selecting one switches Explorer, Results, gutter and status bar to it. Start/Stop act on the selected project; several may run at once and keep running in the background while another is viewed. Limit: setting `liveTestRunner.maxRunningProjects`, default `auto` = 2, or 1 on machines with ≤ 4 CPU cores or < 4 GB free memory; starting one more shows "Stop a running project first" and names the running ones. |
| D12 | A package whose single Vitest config has `test.projects` (vueuse, slidev) is **one** switcher entry, run once from its root; the Explorer groups its files by Vitest project name. |
| D13 | Mixed frameworks (phase 8): a file both frameworks claim with no hint (no `vitest` / `@jest/globals` import, no `vi.` / `jest.`) runs with the project's primary framework + one WARN naming the override setting. |
| D14 | Vitest execution trace (phase 9) is **on by default** like Jest's session trace — it powers "covering tests" and precise source-file on-save reruns; falls back to plain runs when the wrapper config cannot load. |

### Release roadmap

| Release | Scope | Phases |
|---|---|---|
| **3.0.0** | Decouple + Vitest single project: run, pass/fail, logs, coverage; feature matrix | 0, 1, 2, 3, 5, 11.1 |
| 3.0.x | Live per-file streaming, source-file on-save (related tests) | 4, 6 |
| 3.1.0 | Monorepos / multi-project workspaces | 7 |
| 3.2.0 | Mixed-framework projects | 8 |
| 3.3.0 | Execution trace for Vitest | 9 |
| ~~3.4.0~~ | ~~Timeline debugger for Vitest~~ — deferred to a separate release (D9) | 10 |

---

## 1. Goals

1. Decouple everything that is currently written against Jest, so a framework is
   added by implementing interfaces — no edits to `SessionManager`, stores, views.
2. Add **Vitest** as the first new framework, delivered as visible features:
   run + pass/fail → logs → live batch → coverage → related-test on-save →
   mixed-framework projects → (optional) trace + timeline.
3. Never regress existing projects: every phase ends with the **regression gate**
   (§4) — unit tests, e2e, and the real Jest repositories.
4. Handle projects that mix frameworks: each test file runs with *its own*
   framework's binary, config and flags.

## 2. Ground rules

| Rule | Detail |
|---|---|
| Branches | `release/3.0.0` from `main`. Work on `feat/vitest-<phase>` branches, PR into `release/3.0.0`. Never work on `main`/`release/*` directly (CLAUDE.md). |
| Test repos are read-only | `/Users/eshandias/Projects/test/jest-test-projects/*` and `/Users/eshandias/Projects/test/vitest-projects/*` are **never edited**. The harness (task 0.3) runs against a copy and fails if the original changes. |
| Docs with every change | CHANGELOG (root + extension), `docs/architecture.md`, `docs/ai-context.md`, READMEs per CLAUDE.md "Documentation Maintenance". Gif/screenshot needs → `[TODO: USER_INPUT_NEEDED]` placeholders. |
| Logging | `logger.scope()` / `createLogger()` only; no `console.*` (CLAUDE.md rule 8). |
| Dependency direction | `vscode-extension → core → runner`. No VS Code APIs in runner/core. |
| Feature matrix | Every feature PR updates the README framework-feature matrix and `docs/live-test-runner-guide.html` (D7). |
| No breaking settings | Keep `liveTestRunner.jestCommand`; add new settings next to it. |

## 3. Findings that shaped this plan

### 3.1 Corrections & facts about the environment
- `pnpm/setup` **exists** (current major is `@v3`; `@v1` installed pnpm via npm and is outdated — we use `@v3`) and is documented as the replacement for `pnpm/action-setup` + `actions/setup-node` (needs pnpm ≥ 11; this repo pins `pnpm@12.14.0`). The workflows currently use `pnpm/action-setup@v4` + `actions/setup-node@v5` (not v4). It cannot install pnpm 11 on Intel macOS — `macos-latest` is arm64, so fine.
- `main` is at **2.0.4** (released); `release/3.0.0` branches from it.
- Jest test repos (`/Users/eshandias/Projects/test/jest-test-projects`, **4** repos): `jest` (monorepo, Babel), `jest-dom` (Jest + a `vitest` devDep and `vitest.js` entry — negative Vitest-detection case, BUG-37), `sample-react-project` (CRA), `vscode-jest` (ts-jest).
- Vitest test repos (`/Users/eshandias/Projects/test/vitest-projects`), all pnpm monorepos:
  | Repo | Vitest | Shape | Why it matters |
  |---|---|---|---|
  | `unplugin` | 5.0.5 | single project, root `vitest.config.ts`, `coverage.include` set, reporters text/json/html | cleanest **3.0.0 target**; `npm test` runs a fixture-build step first (`nr test:build && vitest run`) — compare against plain `vitest run`, not `npm test` |
  | `slidev` | 5.0.1 | root config `test.projects: ['packages/*','test']` | Vitest-native multi-project; `catalog:` deps |
  | `vueuse` | 4.1.11 | `test.projects` (unit/server/exports/**browser**), `@vitest/coverage-v8`, `reporters: 'dot'`, test script uses `--project=…` | multi-project + **browser mode (Playwright)** + a config reporter we must override |
- Consequence: Vitest's own `projects` means 2 of 3 real repos need multi-project awareness at least for *running from the root*. 3.0.0 handles this by running the root config once (Vitest fans out itself) and excluding browser-mode projects by default (task 2.8); the extension-level multi-root model is phase 7.

### 3.2 Where the code is coupled to Jest (audit)
The *what to run* seams (`IFrameworkAdapter`, `FrameworkAdapter`, `TestRunner`, `IInstrumentedRunner`) are clean. The *how the engine runs* layer is not:

| # | Coupling | Where |
|---|---|---|
| C1 | `new JestRunner(...)` built directly | `SessionManager.ts:158` |
| C2 | `JestRunner` hard-codes `--json`, `--findRelatedTests`, `--coverageReporters`; `Executor` hard-codes `--outputFile`; `ResultParser` reads Jest's JSON | `runner/src/JestRunner.ts`, `execution/Executor.ts`, `parsing/ResultParser.ts` |
| C3 | `SessionTraceRunner` has no interface; injects Jest `setupFilesAfterEnv`, transform, reporter | `session/SessionTraceRunner.ts` (956 lines), `session/instrumentation/*` |
| C4 | `ProjectJestConfig` injected as a concrete type | `extension.ts`, `SessionManager`, `SessionTraceRunner`, `JestInstrumentedRunner` |
| C5 | Single adapter, single project root per session | `extension.ts:309`, `SessionManager` ctor |
| C6 | `jest --listTests` cache for "runnable files" | `SessionManager`, `RunnableFiles.ts` |
| C7 | Closed `Framework` union; silent Jest fallback; `toJestPath/fromJestPath` names; `PLAIN_RUN_HANG_FACTOR` imported from the Jest adapter file; `CoverageMap` assumes Jest coverage shape | `runner/src/types.ts`, `FrameworkDetector.ts`, `JestPaths.ts`, `core/src/CoverageMap.ts` |
| C8 | Output channel and docs say "Jest Output" | `extension.ts`, docs |

### 3.3 Vitest facts (verified against vitest.dev, v5.0.5 current)

| Need | Vitest | Notes |
|---|---|---|
| Run once | `vitest run [files]` | Add `--watch=false`/`CI=1` guard so it never enters watch. |
| Name filter | `-t <regexp>` (full name) | Same escaping approach as Jest's `-t`. Also `file:line` since v3. |
| Machine output | `--reporter=json --outputFile=<f>` | **Jest-compatible** JSON: `testResults[].name/status/assertionResults[]` with `title/fullName/ancestorTitles/status/duration/failureMessages/location{line,column}`. v5: json reporter writes to a file by default (`.vitest/json/output.json`), `stdout:true` to print. Extra: `numTodoTests`, `coverageMap` (v3+ with coverage). |
| Discovery | `vitest list [--filesOnly] [--json]` | v5 parses statically (no execution); `--no-static-parse` to execute. |
| Related tests | `vitest related <files> --run` | Equivalent of `--findRelatedTests`. |
| Coverage | `--coverage.enabled --coverage.provider=v8\|istanbul --coverage.reporter=json …` | Provider is a **separate package** (`@vitest/coverage-v8`/`-istanbul`) — may be missing. Uncovered files appear only if `coverage.include` is set. v5 changed include/exclude to root-relative. |
| Config | `vitest.config.*` wins over `vite.config.*`; `--config`, `--root`; v5 no longer searches parent dirs | Config may be a function; `mergeConfig` available from `vitest/config`. |
| Projects | `test.projects` (workspace file deprecated); `--project <name>` | Maps to Jest `projects`. |
| Live events | Reporter API: `onTestRunStart`, `onTestModuleStart/Collected/End`, `onTestCaseResult`, `onTestRunEnd(modules, errors, reason)`; v5 reporter API "not stable within minors" | Older (<3) lines use `onFinished/onTaskUpdate` — decision Q2. |
| Console per test | Not in the docs I could reach (`onUserConsoleLog` exists in the type but is undocumented) | **Verify with a spike (task 3.1)**; file-level raw output is the fallback and matches today's Jest behaviour (CLAUDE.md §8). |
| Debug | `node node_modules/vitest/vitest.mjs run <file> -t … --no-file-parallelism --test-timeout=0` + `autoAttachChildProcesses`/`--inspect-brk` | |
| Transform/trace | Vite plugin `transform` hook + `setupFiles`; config can be wrapped via `mergeConfig` | Replaces Jest `transform`/`setupFilesAfterEnv`. |
| Runtime | v5 needs Node ≥ 22.12 and Vite ≥ 6.4 | Our fallback runtime (`ELECTRON_RUN_AS_NODE`) may be older → clear error (task 2.1). |

### 3.4 Jest ⇄ Vitest behaviour map (what "same behaviour" means)

| Extension feature | Jest today | Vitest equivalent | Phase |
|---|---|---|---|
| Pass/fail tree | `--json` | `--reporter=json` (compatible) | 2 |
| Run file / test / suite | `--runTestsByPath`, `-t` | `run <file>`, `-t` | 2 |
| Session/stop/hang | spawn + kill tree | identical | 2 |
| Raw output + per-scope output | stdout + scope reruns | default reporter stdout; same scope rule | 3 |
| Inline failure + diagnostics | stack parsing | `failureMessages` + `location` | 3 |
| Streaming per file | `liveReporter.js` | custom reporter (ESM) | 4 |
| Coverage / gutter / hover | `--coverage` json | `--coverage.*` json | 5 |
| On-save related | `--findRelatedTests` | `related --run` | 6 |
| Mixed projects | n/a | router | 7 |
| Per-test line trace | Jest transform | Vite plugin | 8 |
| Timeline debugger | `JestInstrumentedRunner` | `VitestInstrumentedRunner` | 9 |

## 4. Regression gate (run at the end of **every** phase)

1. `pnpm build && pnpm lint && pnpm test`
2. `node e2e/run.js --all` (all fixtures: basic, ts-config, esm-fn-config, cra, + vitest ones as they land)
3. Real repos, via the harness from 0.3 (read-only): `jest`, `jest-dom`, `sample-react-project`, `vscode-jest`. Pass criterion = extension results equal a plain run of the project's own runner (same comparison the existing `repo-*` scenarios do).
4. Vitest repos (`/Users/eshandias/Projects/test/vitest-projects`: `unplugin`, `slidev`, `vueuse`; override with `LTR_E2E_VITEST_REPOS_DIR`) once phase 2 exists.
5. CI green on Linux/Windows/macOS.

## 5. Target architecture (after phase 1)

```
runner
  FrameworkRegistry ── register(adapter)         (open string ids, no closed union)
  FrameworkAdapter    detect · resolveBinary · resolveConfig · getExtraArgs
                      + capabilities{} + createRunner() + parseResult() + outputFileArg()
  CommandRunner (generic)  ← JestRunner / VitestRunner
  Executor (generic: args from adapter)      ResultParser → per-adapter parser

extension
  FrameworkServices { adapter, createBatchRunner(), projectConfig, instrumentedRunner? }
  IBatchRunner (extracted from SessionTraceRunner)  ← JestBatchRunner / VitestBatchRunner
  IProjectConfig                                      ← JestProjectConfig / VitestProjectConfig
  SessionManager(servicesFor(file)) ── later: FrameworkRouter (phase 7)
  instrumentation/shared (trace protocol) · instrumentation/jest · instrumentation/vitest
```

`FrameworkCapabilities` lets features degrade gracefully (a framework without
`trace` shows "not available" for Timeline instead of failing):
`results · output · liveStream · coverage · related · nameFilter · listTests · debug · trace · timeline`.

## 6. Phases & tasks

Legend: **S/M/L** = size; days are focused days.

### Phase 0 — Housekeeping (2.5 d)

**0.1 Release branch + version (0.5 d)**
Sketch: `git switch -c release/3.0.0 origin/main` (2.0.4 is released); bump root + `packages/vscode-extension/package.json` to `3.0.0`; add `## 3.0.0 (unreleased)` headers to both CHANGELOGs; commit this plan as the first commit.
Done when: branch exists, version bumped, PR-checks happy.

**0.2 Workflows → `pnpm/setup@v3` (0.5 d)**
Sketch (`.github/workflows/pr-checks.yml` ×2 jobs, `release.yml`):
```yaml
- uses: pnpm/setup@v3
  with:
    runtime: node@24      # replaces actions/setup-node node-version: 24
    cache: true           # replaces cache: 'pnpm'
    # version omitted: read from packageManager (pnpm@12.14.0 ≥ 11)
```
- It runs `pnpm install` itself → drop the explicit `pnpm install` steps (tests/e2e jobs). In `release.yml` keep the "skip if already released" optimisation with `install: false` and the existing conditional install step.
- Keep `actions/cache` steps for `.npm` and `.vscode-test`.
- Verify on all three OSes (the e2e matrix) — Windows runner is the risk.
Findings: `pnpm runtime` installs **only `node`** (verified locally: no `npm`/`npx` in the bin dir). The e2e job (`npm install` in fixtures) and the release job (`npx vsce/ovsx`) therefore rely on the runner image's own npm; confirm on the first CI run. Fallback if CI shows otherwise: keep `actions/setup-node` in those two jobs only.
Done when: PR Checks (3 OSes) is green; Release is verified by the first real release.
Follow-up (2026-10-22, owner request, branch `bugfix/ci-action-versions` from `feat/vitest-release-docs`): every action bumped to its current major — `checkout@v7`, `cache@v6`, `upload-artifact@v7`, Pages: `configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5` (+ `actions: read`, `.nojekyll` dropped: v4+ of the upload action excludes dotfiles). `pnpm/setup@v3` is current. Verified by the next PR Checks run (3 OSes).

**0.3 Baseline + real-repo harness (1.5 d)**
Sketch:
- Record baseline results of the current build on all 4 repos (counts per file) → `docs/temp_plans/vitest-baseline.json`.
- Generalise `e2e/scenarios/repo-cra.js`/`repo-tsjest.js` into `e2e/scenarios/repo-matrix.js` driven by `LTR_E2E_REPOS_DIR` (default the path above) and `LTR_E2E_VITEST_REPOS_DIR` (default the vitest-projects path above).
- Read-only guarantee: clone to a temp dir (`cp -cR` on macOS/APFS, `cp -a` elsewhere; `node_modules` shared via clone) and compare `git status --porcelain` + a file-mtime digest of the original before/after; fail if changed.
- Each repo is compared against a plain run of its own runner.
Done when: `node e2e/run.js repo-matrix` passes on current code and proves the originals are untouched.

### Phase 1 — Decouple from Jest (9 d) — *no user-visible change; Jest must behave identically*

**1.1 Neutral naming & open types (1 d)** (C7, C8)
Sketch: `Framework` → `type FrameworkId = string` with known constants; `toJestPath/fromJestPath` → `toRunnerPath/fromRunnerPath` (keep deprecated aliases one release); `PLAIN_RUN_HANG_FACTOR` into a shared `constants.ts`; output channel "Jest Output" → "Test Output" (tag `[jest#N]`/`[vitest#N]` stays); `ProjectJestConfig` → interface `IProjectConfig` + class `JestProjectConfig`.
Done (2026-10-20): `FrameworkId` + `FRAMEWORK_IDS` (`jest`, `cra`, `vite`, `unknown`; unused `next` dropped; `Framework` kept as deprecated alias) in `runner/src/types.ts`, used by all adapters and the detector; extension compares against `FRAMEWORK_IDS.cra`. `resolution/JestPaths.ts` → `RunnerPaths.ts` with `toRunnerPath/fromRunnerPath` (+ deprecated `toJestPath/fromJestPath`, unit-tested). `PLAIN_RUN_HANG_FACTOR` → `vscode-extension/src/constants.ts`. `session/IProjectConfig.ts` (`get(root)`, `reset()`); `JestProjectConfig` implements it; `SessionManager`, `SessionTraceRunner`, `JestInstrumentedRunner` take `IProjectConfig` (extension.ts still builds the Jest one — services bundle is 1.4). Channel "Live Test Runner: Test Output" and command title "Show Test Output" (id `liveTestRunner.showOutput` unchanged — the command title rename was not in the sketch, done for consistency). Docs + both CHANGELOGs updated.

**1.2 Generic runner layer (2 d)** (C2)
Sketch: `Executor` takes `outputFileArg(path)` from the adapter (Jest/Vitest both `--outputFile=`, but not assumed); `ResultParser` becomes `adapter.parseResult(raw)` (Jest parser stays, behind the interface); extract `CommandRunner` (run file / files / test case / related / full suite / kill / path normalisation) with abstract `buildArgs(kind, …)`; `JestRunner extends CommandRunner`. `FrameworkAdapter.createRunner(opts)`.
Unit tests: arg-building snapshots for Jest must equal today's args exactly.
Done (2026-10-20): `runner/src/CommandRunner.ts` (abstract: `detectAdapter`, `buildArgs(RunRequest)`, `parseTestList`, `coverageFile`); `JestRunner extends CommandRunner`. `FrameworkAdapter` + `outputFileArg` / `parseResult` / `createRunner(RunnerOptions)`; Jest + CRA share `jestOutputFileArg` / `parseJestResult` / `createJestRunner`; Vite stub throws. `Executor.runWithJsonCapture(cmd, outputFileArg)`. `parsing/runResults.ts` (`emptyRunResult`, `mergeRunResults`). Snapshot test `test/jestRunnerArgs.test.ts` was committed **before** the refactor and passes unchanged; `test/adapterRunContract.test.ts` covers the new adapter methods. Notes: (1) detection moved out of `CommandRunner` into `JestRunner.detectAdapter`, and `FrameworkDetector` builds its adapter list lazily — adapters → runners → detector → adapters is a cycle, and `class … extends CommandRunner` crashed while `CommandRunner` was half-loaded; (2) `SessionManager`'s bootstrap and the extension `JestAdapter` still construct `JestRunner` directly — switching them to `adapter.createRunner()` is task 1.4 (doing it now would make an unsupported Vite project fail at Start instead of at run).

**1.3 `FrameworkRegistry` + detector (0.5 d)** (C7)
Sketch: `ADAPTER_PRIORITY` becomes a registry (`register(adapter, priority)`); detector returns `{adapter, reason}`; unknown project → explicit `unknown` result with the existing Jest fallback kept (logged at WARN), so behaviour is unchanged.
Done (2026-10-21): `runner/src/framework/FrameworkRegistry.ts` (`register` / `unregister` / `get` / `adapters`; same-id register replaces; `default()` lazily with `ADAPTER_PRIORITIES` CRA 300, Vite 200, Jest 100). `FrameworkDetector(registry = default)`; `detect()` / `detectFramework()` unchanged, new `detectWithReason()` → `{ adapter, framework, matched, reason }` (`matched: 'unknown'` on the Jest fallback). The fallback WARN is logged once per project root (detection runs on every runner creation). Diagnostic report shows the reason. Tests: `test/frameworkRegistry.test.ts`.

**1.4 Extract `IBatchRunner` + services bundle (3 d)** (C1, C3, C4, C5)
Sketch: define `IBatchRunner { runFiles(opts), kill(), reset(), … }` from `SessionTraceRunner`'s public surface; `JestBatchRunner = today's SessionTraceRunner`. Introduce `FrameworkServices` and have `SessionManager` take `servicesFor(file|root)` (single provider returning the one Jest bundle for now) — replacing the constructor's `_adapter` + `_projectConfig`, `new SessionTraceRunner`, and `new JestRunner` bootstrap (`TestSession` gets `adapter.createRunner()`). `extension.ts` composes services; `IInstrumentedRunner` is produced by the services bundle too.
Risk: largest refactor; do it in small commits, run the gate after each.
Done (2026-10-21): `session/IBatchRunner.ts` (`BatchRunOptions` = the former inline `runFiles` options); `SessionTraceRunner` → `session/JestBatchRunner.ts implements IBatchRunner`. `framework/FrameworkServices.ts`: `FrameworkServices { framework, adapter, projectConfig, batchRunner, instrumentedRunner, createSessionRunner() }`, `IFrameworkServicesProvider { servicesFor(fileOrRoot), all() }`, `SingleFrameworkProvider`. `framework/jestServices.ts` `createJestServices({ sessionDir, coverageStore, rawLog })` builds exactly what `extension.ts` / `SessionManager` built before (same constructor args). `SessionManager(provider, …)` — `_adapter`, `_projectConfig`, `_sessionDir` params gone; every adapter call goes through `_adapterFor(file|root)`, Stop / restart kill `all()` batch runners. `instrumentedRunner` is required in the bundle for now (2.6 adds the `trace=false` capability). Left for 1.6: Jest wording in `SessionManager` log/status text (`Asking Jest which files it runs…`, `jest --listTests`, …) and `_askJestForRunnable`.

**1.5 Split instrumentation (1 d)** (C3)
Sketch: `session/instrumentation/` → `shared/` (trace record format, writer protocol, doc of the `__strace` contract), `jest/` (transform, reporter, setup, discovery). Pure file moves + import updates; document the protocol in `docs/architecture.md` so Vitest can implement it later.
Done (2026-10-21): `shared/` = `sessionTraceRuntime.js` + `testDiscovery.js` (discovery is static AST parsing, not Jest-specific — Vitest reuses it in 2.5, so it went to `shared/`, not `jest/` as sketched); `jest/` = `sessionTraceTransform.js`, `ltrCoverageSetup.js`, `liveReporter.js`. `out/instrumentation/{shared,jest}/` mirror the layout (`esbuild.js`), runtime paths updated (`JestBatchRunner`, the transform's `RUNTIME_PATH`, the setup file's runtime require, `TestDiscoveryService`). Timeline files (`timeline/instrumentation/`) untouched (timeline is deferred, D4). Protocol documented in `docs/architecture.md` → *Session instrumentation protocol* + `shared/README.md`. Side effect: the transform's hash changed, so users' persistent transform cache rebuilds once.

**1.6 Conformance suite + gate (1.5 d)**
Sketch: `packages/runner/test/adapterConformance.ts` — a reusable suite every adapter must pass (detect true/false cases, arg shape, parse a canned result, kill behaviour); apply to Jest and CRA. Run the full regression gate. Add a "Adding a framework" checklist to `docs/developer-guide.md`.
Done when: gate green, `git grep -i jest` in `SessionManager`, `extension.ts`, `core/` shows only the Jest bundle wiring.
Done (2026-10-21): `packages/runner/test/adapterConformance.ts` (`describeAdapterConformance(case)`: registered id; claims its projects, not others, not a folder without package.json; result-file flag contains the path; canned result with one passing + one failing test; unreadable output → failed result, no throw; created runner passes the file + the adapter's result-file flag through the Executor; kill safe when idle) applied to Jest and CRA in `adapterConformance.test.ts` (16 checks). `FrameworkServices` + `displayName`, `settingsFingerprint()`; `SessionManager` no longer reads `jestCommand` (runnable-files cache key unchanged) and `_askJestForRunnable` → `_askForRunnable`; `core/CoverageMap` comment says istanbul format. "Adding a framework" checklist in `docs/developer-guide.md`. **Grep result:** code coupling left = `createJestServices` in `extension.ts` only; what remains in `SessionManager` is log / message **wording** ("Jest config (testMatch / testPathIgnorePatterns)", "falling back to plain Jest", `jest --listTests` …). Kept deliberately: e2e checks match some of these strings, and the right Vitest wording is decided with the Vitest bundle → **task 2.6** makes these messages framework-aware (`displayName` + per-framework detail).

### Phase 2 — Vitest: run & pass/fail (15 d) — *Feature V1*

**2.1 Runner `VitestAdapter` (1.5 d)** (replaces the `ViteAdapter` stub)
Sketch: `detect` keeps BUG-37 rule (Vitest only when nothing marks the project as Jest — until mixed support, task 7.x relaxes this); resolve binary from `node_modules/vitest/package.json#bin` → `vitest.mjs` (no `.bin` shim → works on Windows); read the installed Vitest version → capability flags per version (baseline ≥ 3; < 3 best-effort: JSON run/parse works, `vitest list`/`related` fall back to glob scan / `--changed`, live reporter needs the legacy shim in 4.1); `resolveConfig`: `vitest.config.*` > `vite.config.*`, else undefined; Node-version check with a friendly error for v5 (Node ≥ 22.12) when only the Electron fallback runtime exists.
Done (2026-10-21, branch `feat/vitest-run` from `release/3.0.0` after PR #35): `framework/adapters/VitestAdapter.ts` replaces `ViteAdapter.ts`; id renamed `vite` → **`vitest`** (`FRAMEWORK_IDS.vitest`, `ADAPTER_PRIORITIES.vitest`; nothing outside the runner used `vite`). Detect = `vitest` dep **or** `vitest.config.*` / `vitest.workspace.*` (hoisted installs) — and no Jest marker; `vite.config.*` alone is not Vitest. Binary = `vitest/package.json#bin` via `require.resolve` (local / hoisted / pnpm), run with node; no npx fallback (a missing install throws an actionable error). `findInstall()` → `{ version, major, entry, nodeRange }`. New `FrameworkAdapter.capabilities(root)` → `FrameworkCapabilities` (`results · nameFilter · listTests · related · liveStream · coverage` — the runner-level subset of §5; `debug/trace/timeline` stay extension-side for 2.6); Jest/CRA all true, Vitest ≥ 3 all true, < 3 `listTests/related/liveStream` false + one WARN. Node check reads Vitest's own `engines.node` (not a hard-coded 22.12) with a small `utils/semver.ts`: editor fallback runtime outside the range → error with a fix; PATH node outside → WARN only (npm test uses the same node); unreadable range → no check. `resolveConfig`: `vitest.config.*` > `vite.config.*` > undefined. `outputFileArg` = `--outputFile=`; `parseResult` = Jest parser until 2.3; `createRunner` throws `UnsupportedFrameworkError` until 2.2; `getExtraArgs` = [] until 2.2. **Guard:** `JestRunner.detectAdapter` returns a refusing stand-in for non-Jest-family adapters, so a working `resolveBinary` can never launch `vitest` with Jest flags; it throws at run time (as the stub did), not at `setProjectRoot`. Tests: `vitestAdapter.test.ts` (detect matrix incl. jest-dom shape, bin/hoisted/missing, capabilities, Node check, config order, read-only check on the 3 real repos), `semver.test.ts`, refusal test in `adapterRunContract.test.ts`, conformance gains a `capabilities` check. Vitest joins the conformance suite in 2.2 (it needs `createRunner`). Note for 2.3: Vitest's JSON has `location` only with `includeTaskLocation` (CLI `--includeTaskLocation`, v3+).

**2.2 `VitestRunner` (2 d)**
Sketch: command shapes — full: `vitest run --reporter=json --outputFile=<tmp> --root <root> [--config c] --passWithNoTests`; file(s): positional paths; test case: `-t '<escaped>'`; `CI=1` + `--watch=false`; never `--ui`. Reuse `CommandRunner`; spawn with `node vitest.mjs` (no shell), same path normalisation rules as Jest where relevant. User override `liveTestRunner.vitestCommand` (shell-quoted like `jestCommand`). Always pass `--reporter` explicitly so a config `reporters: 'dot'` (vueuse) cannot swallow our JSON; honour config-affecting flags from the project's `test` script (`--config`, `--project`, `--root`) like `testScriptJestArgs` does for Jest.

Done (2026-10-21): `runner/src/VitestRunner.ts`; `VitestAdapter.createRunner()` returns it. Commands: `vitest run [abs files] [--config c] [script flags] --reporter=json --includeTaskLocation --passWithNoTests --watch=false [-t p] --outputFile=<tmp>`; `vitest list … --filesOnly --json`; `vitest related <file> … --run …` (< 3 → full run). New `CommandRunner.leadingArgs(request)` puts the subcommand + file paths **first** (Vitest's parser would otherwise read a path as a boolean flag's value; empty for Jest, Jest snapshots unchanged) and `processLabel` → `[vitest#N]` tags (`ExecutorCommand.label`). Deviations from the sketch, from probing real Vitest 4.1/5.0 on scratch clones: (1) **no `--root`** — cwd is the project root, and `--root` would override a config's own `root`; (2) `CI=1` comes from the Executor already (`CI=true`); (3) **`-t` separator**: Vitest 5 tests `-t` against `Outer > Inner > adds`, Vitest ≤ 4 against `Outer Inner adds`, while the json `fullName` is space-joined — `toVitestNamePattern()` turns each literal space of the extension's escaped pattern into `(?: > | )` (suite: `(?: > | |$)`), verified on both versions; (4) `list --json` takes an optional path, so it must be the last arg (it ate a positional in a probe); the list is `[{file, projectName?}]`, deduplicated; (5) absolute file paths select exactly that file; (6) `--includeTaskLocation` and `list --filesOnly` exist since 3.0 (checked in the 3.0.0 / 3.2.0 packages) → gated on major ≥ 3. Test script: `framework/vitestConfig.ts` `testScriptVitestArgs()` keeps `--config/-c` (→ `resolveConfig`, wins over files), `--project`, `--root/-r`, `--dir`, `--mode`, `--environment`, `--globals`, `--dom`, `--(no-)isolate`; follows `nr x` / `npm run x [-- …]` / `npm test` / `pnpm [run] x` / `yarn [run] x` / `bun run x` (+ `cross-env`, env assignments) up to 3 levels with the extra args; positional filters ignored (slidev's `vitest test`); `bench/list/…` scripts ignored. The shared tokenizer now handles quotes inside a token (`--project="browser (chromium)"`). Fixes on the way: Executor no longer prepends `jest` after `npx` when the command names a package (`jestCommand: "npx jest"` ran `npx jest jest`). `refusingAdapter()` shared by both runners. **`liveTestRunner.vitestCommand` setting deferred to 2.4** — the runner already takes it (`RunnerOptions.command`); the setting is declared and read where the extension builds the Vitest bundle. Coverage flags (`--coverage.enabled=true --coverage.reporter=json[-summary]`) are in place but provider detection is 5.1 — 2.4 must not request coverage runs for Vitest before then. Real checks (read-only scratch clones, `drive.js` against the built runner): **unplugin (5.0.5)** discover 28 files; file / suite / single-test runs exact, with line numbers; related + full run; full run = plain `vitest run` (28 files, 142 passed, 30 failed — fixture tests need unplugin's `test:build` pre-step, plus 2 probe failures). **vueuse (4.1.11)** script → `--project=unit --project=server`; discover 135 files; scoped runs exact; full run = plain `vitest run --project unit --project=server` (135 files, 942 passed, 1 failed, 80 s). (Correction from 2.3: the "27 vs 29" pending count noted here was my comparison adding Vitest's `numTodoTests`; Vitest's own `numPendingTests` is 27 — no gap.)

**2.3 Result parsing (1.5 d)**
Sketch: map Vitest JSON → `RunResult/FileRunResult`: status mapping (`passed/failed/skipped/pending/todo`), `ancestorTitles`, `location`, `failureMessages` (ANSI-strip), file-level collection errors (no assertionResults + `message`) → file failed; `.each` titles → existing template handling. Store canned JSON from Vitest 1.x…5.x as fixtures.

Done (2026-10-21): `runner/src/parsing/VitestResultParser.ts` `parseVitestResult()`, used by `VitestAdapter.parseResult`. Built from real reports of **Vitest 1.6.1, 2.1.9, 3.2.4, 4.1.11, 5.0.5** (1–3 installed in a scratch dir, 4/5 from the repos' installs) on the same four probe files, kept as `runner/test/fixtures/vitest/v*.json` (paths → `/project`). What the reports showed: (1) Vitest 1 adds the file as an unnamed ancestor (`['', 'Outer']`, `fullName ' Outer adds'`) → dropped, fullName rebuilt from ancestors + title; (2) Vitest 1's counts are wrong (8 passed for 4) → counts from the tests; pending = skipped/pending, **not** todo (Jest's and Vitest's own meaning); (3) load errors / empty files: no tests, reason in `message` → `failureMessage`; (4) **a failing `beforeAll`: file `failed`, empty `message`, tests `skipped` (v1: `pending`) — the error is in neither the JSON nor stdout/stderr** → `failureMessage` = `VITEST_HOOK_FAILURE` (explains and says to run it in a terminal; the real text comes with 3.1's default reporter or 4.1's reporter); (5) **an unhandled rejection: exit 1, `success: true`, every test passed, nothing printed** → `errors = [VITEST_UNHANDLED_ERROR]`; (6) `location` only with `--includeTaskLocation` (v1/v2: none); Vitest 1 puts the *assertion* position on failed tests only → dropped when only failed tests have one; (7) fractional ms durations → rounded; (8) no colour codes in the JSON even with `FORCE_COLOR` (stripped anyway), stack lines stripped from messages; (9) the json reporter drops console output entirely (→ 3.1); (10) `toEqual` diffs are not in `failureMessages` (only `error.stack`) → 3.2. Unknown statuses (`disabled`) → `skipped`. Not done here, for 2.4: the extension's plain-run apply ignores `FileRunResult.failureMessage` (a file that fails to load shows its tests as pending, no reason) — 2.4 must surface it. Check: unplugin clone full run through the built runner = plain `vitest run` test by test (201 tests, 142/30/27, 9 failed files, all with a reason).

**2.4 Extension `VitestAdapter` (3 d)**
Sketch: implements `IFrameworkAdapter`: `discoverTests` (`vitest list --filesOnly --json`, fallback to include-glob scan), `getFileGlob/isTestFile` from config `include`/defaults (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), `runFile`, `applyFileResult`, `runTestCase`, `getDebugConfig` (node launch of `vitest.mjs run <file> -t … --no-file-parallelism --test-timeout=0`), `getAffectedTests` (coverage map; real impl phase 6), `runRelatedTests` (stub → phase 6, "not available" capability until then).

Done (2026-10-21): the extension `JestAdapter` was split — `framework/RunnerBackedAdapter.ts` holds the framework-neutral half (moved verbatim: file / test-case / related runs, `FileRunResult` → `ResultStore`), `JestAdapter` keeps detection, `JestRunner` + `jestCommandSetting`, debug config. `framework/VitestAdapter.ts`: detection (runner adapter), `VitestRunner` with **`liveTestRunner.vitestCommand`** (setting added here; `runMode: npm` is Jest-only → one WARN), debug config = Vitest's recommended launch (`vitest.mjs run <file> [-t]` + script flags + `--no-file-parallelism --test-timeout=0 --hook-timeout=0 --coverage.enabled=false`, `autoAttachChildProcesses`, `smartStep`). Discovery = `vitest list` (runner), glob/`isTestFile` = the shared patterns (Vitest's default include is a subset; `vitest list` filters). `getAffectedTests` = coverage map; `runRelatedTests` = `vitest related` already works through the runner (polish in phase 6). Beyond the sketch, needed to run at all: (1) **`session/VitestBatchRunner.ts`** (the session runs files through `batchRunner`; without one every batch fell back to "plain Jest" per file) — one process per batch, results applied when it exits, generation/ownership/kill like Jest's, whole-batch limit `hangTimeoutMs × PLAIN_RUN_HANG_FACTOR` then SessionManager's per-file retry pins the hanging file; `session/VitestProjectConfig.ts` (config file path); `framework/vitestServices.ts`; (2) **`DetectingFrameworkProvider`** replaces `SingleFrameworkProvider` in `extension.ts` (bundle per detected framework, built lazily; services were built at activation before a root was known); `instrumentedRunner` optional (from 2.6) + delegating runner with "not available for Vitest yet"; (3) **discovery had no Babel**: `testDiscovery.js` only loaded the project's `@babel/parser`/`traverse` (present in every Jest project via Jest, absent in Vitest projects → 0 tests) — now falls back to `@babel/parser` 7.29.2 shipped as `out/vendor/babel-parser.js` (512 KB, self-contained, MIT; devDependency + `esbuild.js` copy — the .vsix is built with `--no-dependencies`) and a built-in `CallExpression` walker; and `vitest` joined `JEST_GLOBAL_PACKAGES` (imports from it were treated like tstyche's → 0 tests). The rest of 2.5 (`.for`, `skipIf`, `test.extend`, …) stays in 2.5; (4) a file that fails to load (`failureMessage`, no tests) now fails its discovered tests with the reason, for any framework (Jest batch crashes included; before: pending, no reason); a file-level failure with tests (Vitest hook) goes into the file's output. Runnable-files cache key: Vitest/Vite config files count only when present (Jest keys unchanged). Feature matrix: `docs/framework-features.md` + `scripts/framework-matrix.js` (writes README + guide; `--check`), README banner / quick start / settings / gif placeholder updated (D7). e2e: fixture `vitest-basic` (Vitest 3.2.4) + scenario `vitest-full-run` (20 checks, PASS).

**2.5 Static discovery syntax (1.5 d)**
Sketch: check `TestDiscoveryService`'s parser covers `test/it/describe` + `.skip/.only/.todo/.concurrent/.each/.for/.skipIf/.runIf`, `test.extend` fixtures, `import { test } from 'vitest'`; add missing forms and unit tests.

Done (2026-10-21): `testDiscovery.js` — per-file name context (`_collectTestNames`): renamed imports from jest / vitest (`test as base`), Vitest `suite` (only when imported from vitest — a bare `suite(...)` stays ignored, Jest has none), aliases from `.extend(…)` (chains, TS generics, `as`/`satisfies`, repeated until stable so aliases of aliases work); `getCallType` treats `.each/.for/.skipIf/.runIf` as curried (tagged templates: `.each/.for`); `.skip/.only/.todo/.concurrent/.sequential/.fails` were already covered by the member-root rule; `test`/`it`/`describe` imported from project modules (relative, `@/`, `~/`, `#`) are no longer "shadowed" (the tstyche rule now only applies to other packages); `bench` ignored. Found on the way (both pre-existing, any framework): (1) the inner `describe.each([...])` call of a curried describe popped the suite on exit → its tests landed at the file root until a run rebuilt the tree — exit now pops only for calls that opened a suite (`WeakSet`); (2) the JSX plugin was on for `.ts` files, so a generic arrow `<T>(…) =>` failed the whole parse (vueuse `useFetch/index.test.ts`) — off for `.ts/.mts/.cts`. Unit tests: `vscode-extension/test/testDiscovery.test.ts` (12, run with the shipped parser + walker). Real repos (read-only): unplugin 26/26 files (180 tests), slidev 38/39 (314), vueuse 226/227 (1568; was 1514 before the JSX fix) — the two without static tests are generated (`describePackagesApiSnapshots(...)`); Jest repos discover exactly as before (vscode-jest 884, CRA 137). e2e: `vitest-basic/src/syntax.test.ts` + 2 checks in `vitest-full-run` (discovered before Start; results 4 passed / 1 skipped).

**2.6 Session behaviour parity (1 d)**
Sketch: confirm Start/Stop/hang detection/on-save-without-trace/session guard work through the plain-run path (`SessionManager` ~line 802) with Vitest; `Stop` is final; capability `trace=false` → timeline/“Covering tests” show “not available for Vitest yet”. Also (from 1.6): make `SessionManager`'s log / status messages framework-aware — today they name Jest and Jest options (`testMatch / testPathIgnorePatterns`, `jest --listTests`, "plain Jest"); use the bundle's `displayName` plus a per-framework detail, and update the e2e checks that match those strings. `instrumentedRunner` becomes optional in `FrameworkServices` here.

Done (2026-10-21): confirmed through e2e in real VS Code — new scenarios `vitest-session` (guard: save before Start runs nothing; saved test file reruns alone; saved source file → "No trace data … using vitest related" → `vitest related <file> --run`; ▶ Run → `-t` pattern, siblings unchanged; save after Stop runs nothing), `vitest-stop` (Vitest CLI + workers gone 4 s after Stop, no new process, no results after Stop, nothing spinning), `vitest-hang` (`hangTimeoutSeconds: 10`: the batch with an infinite loop is stopped at 30 s, its files retried one by one, only `loop.test.js` failed "hangs"; never-resolving promise failed by Vitest's 5 s timeout; other files correct; no process left; run ≈ 61 s). Framework-aware wording: `FrameworkServices.terms` (`FrameworkTerms`: name, config, configRules(Short), listCommand, relatedCommand, batchRun, plainRun, fallbackLoss) — every Jest-named message in `SessionManager` uses it; Jest's strings are byte-identical (e2e checks match them). `FrameworkServices.features` (`trace`, `timeline`; Vitest false/false). `instrumentedRunner` optional and the Timeline "not available for Vitest yet" were done in 2.4. **Deferred to 5.2:** the coverage hover's "covering tests" list — it only appears once a file has coverage, which Vitest gets in phase 5; then it must say "covering tests: not available for Vitest yet" (`features.trace === false`) instead of an empty list. Harness: `vitestProcesses()` — Vitest sets `process.title` (`node (vitest)`, `node (vitest N)`), so the workspace path is not in `ps`; titles are matched too (macOS/Linux; Windows keeps the command line).

**2.8 Vitest `projects` & browser-mode guard (1.5 d)**
Sketch: run from the root config once — Vitest fans out over `test.projects` itself (slidev, vueuse). Browser-mode projects (Playwright/WebdriverIO, e.g. vueuse `browser`) are excluded by default (`--project '!<name>'` resolved from `vitest list`/config; setting `liveTestRunner.vitestIncludeBrowserProjects`), with an INFO line explaining. Test results carry the project name for later display (phase 7). Honour `--project` in the user's `test` script when present.

Done (2026-10-21): `runner/src/framework/vitestProjects.ts` — a probe script (written to the session dir, run with node through the Executor, tagged `[vitest#N]`) calls the project's own `vitest/node` `createVitest('test', { config })` and prints `[{ name, browser: config.browser.enabled }]`; cached per root by config path + mtime + package.json mtime; ~0.1–0.8 s (checked on Vitest 1.6, 2.1, 3.2, 4.1 vueuse, 5.0 slidev/unplugin; 1.x/2.x use `workspace` files so they report one project — fine for the guard). `VitestRunner.prepare()` (new `CommandRunner.prepare(root, config)` hook, awaited before each command) — no guard when the test script has `--project` (vueuse's `npm test`) or `includeBrowserProjects`; otherwise, with browser projects present, `--project=<name>` for every non-browser project (positive list: `--project '!name'` negation is newer than the v3 baseline) on every command (list / run / related) + one INFO per root; all-browser config → run them with a WARN. Setting `liveTestRunner.vitestIncludeBrowserProjects` (default false; in the Vitest settings fingerprint) → `RunnerOptions.includeBrowserProjects`. Unit tests `test/vitestBrowserGuard.test.ts` (5; seam `_setVitestProjectsReader` — the esbuild jest transform does not hoist `jest.mock`). Real check on a vueuse clone with `test: "vitest run"`: browser (chromium/webkit) left out, results = plain `vitest run --project=server --project=unit --project=exports` (136 files, 942 / 63 failed — 62 in `test/exports.test.ts`, which needs a build). Not done: per-file project name in results — the json reporter does not report it (`vitest list --json` does) → phase 7 / live reporter (4.1). Running from the root config once (slidev, vueuse) needed no code — verified in 2.2.

**2.7 Tests (3 d)**
- Unit: adapter detect matrix (vitest only / jest only / both / neither / `jest-dom` shape), arg builders, parser fixtures per version, registry.
- Fixtures: `e2e/fixtures/vitest-basic` (+ later `vitest-ts`, `vitest-esm`), scenarios `vitest-full-run`, `vitest-scoped-run`, `vitest-stop`, `vitest-hang`, `vitest-on-save`, `vitest-debug`.
- Add `unplugin`, `slidev`, `vueuse` to the repo matrix (compare with plain `vitest run`; vueuse with browser projects excluded).
Gate → **tag milestone M1** (Vitest run & pass/fail).
Done (2026-10-21) → **M1 reached**: Vitest projects run and show pass/fail in the extension. Unit: adapter detect matrix + conformance (2.1/2.2), arg snapshots, parser fixtures per version 1.6–5.0 (2.3), registry, discovery (2.5), browser guard (2.8). e2e on `fixture:vitest-basic` (Vitest 3.2.4): `vitest-full-run`, `vitest-scoped-run` (new: test / suite / `.each` template patterns, nothing else touched), `vitest-session` (= the sketch's `vitest-on-save`, plus guard / ▶ Run / after Stop), `vitest-stop`, `vitest-hang`, `vitest-debug` (new: launch config runs exactly 1 test, a suite's 2, both `.each` rows). `vitest-ts` / `vitest-esm` fixtures were not needed: `vitest-basic` is ESM (`"type": "module"`, `.mjs` config) and has a TS test file. Real repos: `repo-vitest` scenario; `real-repos.js` computes a plain `vitest run` baseline (with the test script's flags) per clone — **unplugin (5.0.5) 26 files, slidev (5.0.1) 29 files, vueuse (4.1.11, `--project unit --project=server`) 134 files: results equal plain Vitest test for test**; discovery before Start, ▶ Run, save-to-rerun, Stop (no process left) pass on all three. Found with slidev: `test/api-snapshots.test.ts` (tests generated at runtime by `describePackagesApiSnapshots`) was missing — discovery drops files without static tests, and the "files the framework runs but discovery missed" path re-ran the same discovery; `TestDiscoveryService.addFiles` now keeps such files (`keepEmpty`), for any framework.

### Phase 3 — Logs & output (4.5 d) — *Feature V2*

**3.1 Output capture (2 d)** — spike first: does `onUserConsoleLog` give per-test attribution? If yes, document it as a Vitest improvement; otherwise keep the file-level rule (never back-fill). Run with `--reporter=default --reporter=json` (+ `--outputFile.json=`) so raw stdout streams to the Test Output channel and Results pane.
Done (2026-10-21, branch `feat/vitest-logs` from `feat/vitest-run`): spike answered **yes** — `onUserConsoleLog` gives the task that printed each line on every version (1.6, 2.1, 3.2, 4.1, 5.0): test-body logs → the test, `beforeAll` → its suite, module scope / describe bodies → the file (v1: `taskId` = `<file>:<line>:<col>`, not in `idMap`). `task.suite` is not filled in for suites on v2+ in the main process, so the reporter finds the chain by searching the file's task tree. Runner: `framework/vitestReporter.ts` (reporter source written to the session dir once; `readVitestEvents`, `toConsoleEntry`), `VitestRunner` runs `--reporter=default --reporter=<ours> --reporter=json` (json → `--outputFile.json=`), `runEnv` sets `LTR_VITEST_EVENTS` per run, `afterRun` attaches entries; `ConsoleEntry.scope` / `scopeName`; `CommandRunner.runEnv/afterRun/forwardsStdout` hooks; `ExecutorCommand.forwardStdout` (Vitest's default reporter prints to stdout → Test Output channel). Extension: `RunnerBackedAdapter` — when entries carry a scope, each touched test that ran gets exactly its own lines (empty, with `capturedAt`, for a quiet test — known, not a placeholder), suites their hooks' lines, the file all lines on a whole-file run; scoped / pattern reruns update only what ran. Documented as a Vitest improvement (CLAUDE.md §8, architecture, README, guide, matrix "✅ per test"). Unit: `test/vitestConsole.test.ts`. e2e: `vitest-basic/src/logs.test.js` + `vitest-output` (10 checks, part of 3.3).

**3.2 Failure details & inline diagnostics (1.5 d)** — parse Vitest stack frames (strip `vite-node`/`❯` noise, map `file:line:col`), use `location` for the test line, feed `utils/diagnostics.ts`.
Done (2026-10-21): spike first — on every version the finished task tree carries each test's errors with `diff` (ANSI on < 4), `stack`, and on 4+ parsed, source-mapped `stacks`; **a failing `beforeAll` has its error on the suite** (the json report drops it), load errors on the file. The reporter gained a run-end pass (`onTestRunEnd` 3+, `onFinished` 1–2 — 4+ removed it; guarded to run once) writing `{ ev: 'error', scope, names, errors }`; `errorLocation()` takes the first project frame (from `stacks`, else parses V8 `at …` / `❯ …` lines, skipping node_modules / node: / vitest internals); `formatVitestError()` → `Name: message` + plain diff + `❯ rel/path:line:col`. `VitestRunner.afterRun()`: test errors replace the json `failureMessages`; suite / file errors become `FileRunResult.failureMessage` (replacing 2.3's placeholder; a json load message gains its location) and fail the file. Extension: a file failure with tests present (hook) → `store.fileResult(file, 'failed')` on whole-file runs, the reason in the file output; its tests keep Vitest's status (skipped). Checked on 1.6 / 3.2 / 5.0 (v1's load error stack has no project frame → no location). **Not done — owner decision:** the sketch's "inline diagnostics" assumed an editor-diagnostics feature that does not exist for Jest either (`utils/diagnostics.ts` is the Copy Diagnostic Report); failure details go to the Results panel's error column. Adding VS Code `Diagnostic`s (squiggles at the failure line) would be a new feature for both frameworks — the locations are now available for Vitest (and parseable for Jest). Unit: `test/vitestErrors.test.ts` (4). e2e: `vitest-basic/src/hook.test.js` + 5 checks in `vitest-output` (diff, `.ts` source-mapped line, hook file failed with real error + location, load error location).

**3.3 Tests (1 d)** — scoped output rerun e2e (`vitest-output`), unit tests for stack parsing.
Gate → **M2a**.
Done (2026-10-21) → **M2a reached** (Vitest logs & output). Written with 3.1 / 3.2: e2e `vitest-output` (15 checks: per-test / suite / file output, quiet test, Vitest's own output in Test Output, output kept across a scoped rerun, diff, source-mapped location, hook failure, load-error location); unit `vitestConsole.test.ts` (2), `vitestErrors.test.ts` (4). Gate after 3.2 is the phase gate (6/6 real repos).

### Phase 4 — Live per-file streaming & batch (6.5 d) — *Feature V3*

**4.1 Live reporter (3 d)** — ESM reporter module (`instrumentation/vitest/liveReporter.mjs`) appending `FileRunResult` JSON lines to `LTR_REPORTER_FILE` on `onTestModuleEnd`, start records on `onTestModuleStart`; compatibility shim for the older `onFinished/onTaskUpdate` API if cheap (D2). Loaded with `--reporter=<abs path>`.
Done (2026-10-21, branch `feat/vitest-live`): spike — new reporter API events arrive live on 3.2 / 4.1 / 5.0; `onTaskUpdate` works live on 1.6 **and 2.1** (2.1 has `getReportedEntity` but no `onTestModuleStart/End`, so "modern" = `parseInt(ctx.version) >= 3`, not feature detection). The existing runner-owned reporter (no separate `.mjs` in the extension — the runner writes it to the session dir, like the project probe) now also writes `file-start`, `test-start` / `test-end`, and `file-end` with a json-reporter-shaped result built from the finished task tree (`STATUS` map = the json reporter's; empty suite names skipped); failures are written per file at its end (deduplicated, run end catches crashed files). Legacy file detection = `typeof task.filepath === 'string'` (Vitest 2 suites have no parent link). Runner: `liveFileResult()`, `applyVitestEvents()` (moved out of `afterRun`, shared), `VitestRunner.liveCommand(files)` → `{ command, eventsFile, resultFile }` (`commandArgs` / `resolveBinary` now protected). Verified with a polling driver on 1.6 / 2.1 / 5.0: fast files' results at 0.6–1 s, the 2.5 s file's at ~3 s.

**4.2 `VitestBatchRunner` (2 d)** — implements `IBatchRunner` without trace: one process per batch, hang detection from start records, kill process tree, `--no-file-parallelism` never forced.
Done (2026-10-21): `session/VitestBatchRunner.ts` rewritten on the live events — `runner.liveCommand(files)` + `Executor.runWithReporterPolling(command, eventsFile, onRecord)`; `file-start` → `onFileStart` (owned files); `log` / `error` buffered per file; `file-end` → `liveFileResult` + `applyVitestEvents` → `applyFileResult` + `onFileDone`; generation / ownership / kill as before; result and events files deleted. Hang handling: per-test limit from heartbeats (`test-start` without `test-end` > `hangTimeoutMs` → kill, `onFileTimedOut` for that file, the rest missing → retried); **found by `vitest-hang`:** a worker in a synchronous infinite loop never flushes its "test started" update (Vitest batches worker → main updates), so the heartbeat never comes — added a no-progress fallback (no event at all for `hangTimeoutMs × PLAIN_RUN_HANG_FACTOR` → kill, unfinished files missing → SessionManager's one-by-one retry pins the hanging file; ≈ 97 s with a 10 s limit). Reporter order fixed: failures before `file-end` (the live reader applies on `file-end`). Slow-batch warning every 60 s names the files running. `--no-file-parallelism` is not forced (sketch). e2e: `vitest-batch`, `vitest-save-during-run` (new), `vitest-hang` (either hang path); matrix "Live per-file progress" → ✅.

**4.3 Tests (1.5 d)** — `vitest-batch`, `vitest-save-during-run`, reporter unit tests with synthetic events.
Gate → **M2b**.
Done (2026-10-21) → **M2b reached** (Vitest live progress). e2e `vitest-batch`, `vitest-save-during-run` (written with 4.2); reporter unit tests `runner/test/vitestReporterSource.test.ts` (4) — the generated ESM reporter is loaded in a child node process and driven with synthetic task trees / hooks for both API paths, crash-at-run-end, hook failures and Vitest 1 console tags. Gate after 4.2 is the phase gate (6/6 real repos through the live batch runner).

### Phase 5 — Coverage (4.5 d) — *Feature V4*

**5.1 Coverage run (2 d)** — `--coverage.enabled --coverage.reporter=json --coverage.reporter=json-summary --coverage.reportsDirectory=<session>/cov`; provider detection (`@vitest/coverage-v8`/`-istanbul` present?) → if missing, an actionable message (“install @vitest/coverage-v8”) instead of a failed run; set `coverage.include` to the source globs so uncovered files show; handle v5 root-relative include/exclude.
**5.2 Map into `CoverageStore`/`CoverageMap` (1 d)** — normalise paths; confirm json is istanbul-shaped for both providers; thresholds and gutter/hover unchanged (they read the store).
Done (2026-10-21, 5.1 + 5.2 together — the run and the mapping only make sense as one change; branch `feat/vitest-coverage`): spike on the real repos — only vueuse has a provider (`@vitest/coverage-v8` 4.1.11); unplugin / slidev have none; with `--coverage.reporter=json --coverage.reportsDirectory=<dir>` Vitest writes `coverage-final.json` only there (istanbul shape: `statementMap/fnMap/branchMap/s/f/b`); vueuse's `coverage.include` reports all 361 included files (untested ones at 0 — fine, they are measured). **5.1:** the project probe also prints `coverage.provider`; `vitestConfigInfo()` (cached with the projects) + `vitestCoverageInstalled()`; `VitestRunner.liveCommand(files, { coverageDir })` adds `--coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory=<session>/vitest-coverage/<batch> --coverage.reportOnFailure=true` (`reportOnFailure`: older Vitest writes no coverage when a test fails) and `--coverage.all=false` below 4 (v3 defaults `all: true` → would instrument the whole project); missing provider → one INFO "coverage is off … npm i -D @vitest/coverage-<provider>". `coverage.include` is left to the config (untested files come from the extension's source scan). Thresholds in the config may fail the exit code — results are unaffected. The unused full-suite coverage run now writes into the session dir. **5.2:** `vscode-extension/src/coverage/istanbulCoverage.ts` — `toManifest()` (statements → start/end, branches → type / line / arms, functions → name / decl line / end line) + manifest per file version in `<session>/vitest-manifests/<sha1(path + maps)>.json`, counters max-merged when the manifest is the same, `calculate()` for the pct, exclusions shared with Jest (`coverage/coverageRules.ts`, moved verbatim from `JestBatchRunner`). `VitestBatchRunner` gets the CoverageStore + session dir and applies the batch's coverage when it ends (not after Stop). Also: `SourceCounter` (untested files' 0-hit counts) needed the project's Babel too → `utils/babel.ts` (`loadBabelParser`, `loadTraverse`, minimal `walk` with node / parent / parentKey); the hover's "trace data unavailable" → "covering tests are not available for Vitest yet" (`features.trace`, deferred here from 2.6) and partial-branch detail without a trace. Unit: `runner/test/vitestCoverageArgs.test.ts` (4; seam `_setVitestConfigReader`). e2e: `vitest-coverage` (10 checks: math.js measured 100 % with manifest, untested.js counted, no Babel warning, test files not measured, totals, hover text, no `coverage/` in the project). Matrix: coverage ✅ (needs the provider package).

**5.3 Tests (1.5 d)** — `vitest-coverage` e2e, missing-provider path, unit tests on the mapping.
Gate → **M3a**.
Done (2026-10-22, branch `feat/vitest-coverage-tests` from `release/3.0.0` after PR #39) → **M3a reached** (Vitest coverage). `vitest-coverage` e2e was written with 5.1/5.2; the missing-provider path is unit-tested in the runner (`vitestCoverageArgs.test.ts`) and now checked on the real repos: `repo-vitest` asserts coverage measured when the clone can resolve `@vitest/coverage-v8`/`-istanbul` (vueuse: 361 files, only project files, no "coverage is off"), otherwise exactly one "coverage is off" line and nothing measured (unplugin, slidev), and no `coverage/` folder appears. Mapping unit tests `vscode-extension/test/istanbulCoverage.test.ts` (9: manifest incl. entries without `decl` / branch `loc`, pct, max-merge per file version, changed file starts over, scan count replaced, exclusions, key fallback); the extension's unit tests now map `vscode` to `test/vscodeStub.ts` (EventEmitter, LogLevel) so store / coverage modules load. **Found:** `isExcludedFromCoverage` got a project-relative path while its folder rules need a leading separator → top-level `test/`, `__tests__/`, `dist/`, `coverage/` … files were measured as source (Jest too) — fixed (leading `/` added before matching).

### Phase 6 — Related tests & on-save (3 d) — *Feature V5*

**6.1 `runRelatedTests` (1.5 d)** — `vitest related --run <abs src>`; result applied through the normal path; `getAffectedTests` via coverage map first (framework-agnostic), then `related`.
**6.2 Edge cases (0.5 d)** — `--passWithNoTests`, files outside the module graph, config-changed saves.
**6.3 Tests (1 d)** — `vitest-on-save` extended to source-file saves.
Gate → **M3b**.

### Phase 7 — Monorepos & multi-project workspaces (17 d) — *3.1.0, Feature V6*

Today a session has **one** `projectRoot`. Goal: a user can open a monorepo or a multi-root VS Code workspace and run the projects they choose, each with its own framework/config. (Vitest-native `projects` already work from a single root from 3.0.0; this phase is the extension-level model.)

**7.1 Design spike (2 d)** — how projects are found: `pnpm-workspace.yaml`/`package.json#workspaces`, VS Code workspace folders, nearest `package.json`/config with a test framework; how the user picks (setting `liveTestRunner.projects` + a picker command, enabling/disabling projects); relationship to Vitest `projects`. ADR appended here.
**7.2 `ProjectContext` model (5 d)** — replace the singular root in `SessionManager`, discovery, caches and stores with `ProjectContext[]` (`{id, root, framework, services}`); file ids namespaced by project; session start/stop applies to the selected set; per-project session dirs.
**7.3 Discovery, cache & runnable lists per project (2 d)**.
**7.4 UI (2 d)** — Explorer groups by project; status bar totals; project picker.
**7.5 Vitest/Jest project specifics (2 d)** — Vitest `--project` names shown under the project; Jest `projects` (jest repo).
**7.6 Coverage per project, merged view (1.5 d)**.
**7.7 Tests (2.5 d)** — fixtures `monorepo-jest`, `monorepo-vitest`; real repos `jest`, `slidev`, `vueuse`; e2e `monorepo-select`, `monorepo-run`, `monorepo-stop`.

### Phase 8 — Mixed-framework projects (13 d) — *3.2.0, Feature V7*

Prerequisite: phase 7 confirmed. Principle: **a test file's framework decides its binary, config, flags, runner, reporter and coverage settings.** Frameworks run as separate processes per batch; results merge into one `ResultStore`.

**8.1 Design spike (2 d)** — file→framework resolution, in priority order:
1. Setting `liveTestRunner.frameworks` (glob → `{framework, config?, root?}`) — explicit wins.
2. Nearest project context (phase 7): a package that is Vitest-only or Jest-only.
3. Ownership by each framework's own config: Jest `--listTests` ∩ Vitest `vitest list --filesOnly`.
4. Conflicts: file imports from `vitest`/uses `vi.` → Vitest; `@jest/globals`/`jest.` → Jest; else the primary framework + WARN once.
`jest-dom`-style projects (Vitest dep, Jest tests) stay Jest via rule 3. ADR appended here.
**8.2 `FrameworkRouter` + partitioned runs (4 d)** — `servicesFor(file)`; group a run by `(framework, project)`; record framework per file node; Stop kills all groups; BUG-37 rule replaced by router rules.
**8.3 Per-framework discovery & runnable filter (1.5 d)** (C6).
**8.4 Coverage merge (1.5 d)**.
**8.5 UI (1.5 d)** — framework badge, status bar “Jest 12 · Vitest 8”, settings docs.
**8.6 Tests (2.5 d)** — fixtures `mixed-same-package`, `mixed-monorepo`; e2e `mixed-full-run`, `mixed-on-save`, `mixed-stop`.

### Phase 9 — Execution trace for Vitest (10 d) — *3.3.0, Feature V8*

**9.1 Spike (2 d)** — wrapper config: generate `ltr.vitest.config.mjs` in the session dir that loads the user's config (`loadConfigFromFile`; function/async/TS safe), `mergeConfig`s our plugin + `setupFiles` + live reporter, passed with `--config`. Handle `projects`, v5 no-parent-config rule, `root`.
**9.2 Vite plugin transform (5 d)** — port `sessionTraceTransform` to a Vite `transform` hook; `globalThis.__strace` per worker via setup file; per-test context via `beforeEach`/`onTestFinished`; ESM/TS ordering (`enforce`), source maps.
**9.3 Trace store integration (1 d)** — same JSONL format; “Covering tests”/hover untouched.
**9.4 Perf & tests (2 d)** — large-repo timing, `vitest-trace` e2e.

### Phase 10 — Timeline debugger for Vitest (8 d) — *3.4.0, Feature V9*
**10.1 `VitestInstrumentedRunner` (3 d)** (`IInstrumentedRunner`) · **10.2 Step/variable capture on the Vite plugin (3 d)** · **10.3 Tests (2 d)** (`vitest-timeline`). (The Jest timeline is untouched.)

### Phase 11 — Docs, feature matrix & release

**11.1 Framework feature matrix + guide (3 d, part of 3.0.0)**
- README (`packages/vscode-extension/README.md`, marketplace-facing) gets a short table, one column per framework, one row per feature, cells `✅ / 🟡 partial / ⏳ planned / —`:

  | Feature | Jest | CRA | Vitest |
  |---|---|---|---|
  | Run & pass/fail | ✅ | ✅ | ✅ 3.0 |
  | Logs / output | ✅ | ✅ | ✅ 3.0 |
  | Coverage (gutter, hover) | ✅ | ✅ | ✅ 3.0 |
  | Live per-file streaming | ✅ | ✅ | ⏳ 3.0.x |
  | On-save related tests | ✅ | ✅ | ⏳ 3.0.x |
  | Monorepo / multi-project | 🟡 | — | ⏳ 3.1 |
  | Mixed frameworks | — | — | ⏳ 3.2 |
  | Execution trace / “covering tests” | ✅ | ✅ | ⏳ 3.3 |
  | Timeline debugger | ✅ | ✅ | ⏳ 3.4 |
  | Debug (▷) | ✅ | ✅ | ✅ 3.0 |
- Same table (kept in one source, `docs/framework-features.md`, copied into both) in `docs/live-test-runner-guide.html`, plus a Vitest section and the mixed/monorepo behaviour as they land. Each later feature PR flips its cell.
- Update `docs/architecture.md`, `developer-guide.md` (“Adding a framework” + conformance), `ai-context.md`, runner/core READMEs, both CHANGELOGs; `[TODO: USER_INPUT_NEEDED]` gif placeholders for Vitest run and coverage.
Done (2026-10-22, branch `feat/vitest-release-docs` from `feat/vitest-coverage-tests`): the matrix (`docs/framework-features.md` → README + guide) already existed from 2.4; this task: guide *Vitest* section (detection, versions, config flags, per-test output, failures, coverage provider, projects / browser guard, what is missing), Jest-only wording made neutral, Debugging section without the fixed BUG-05/06 warning, *Known issues* = the open bugs (BUG-43/44) instead of fixed ones, guide links to the .md docs as absolute GitHub URLs (they must work on Pages and in the Open Guide tab); Timeline cell for Vitest "⏳ later" (D9). README: guide link, Open Guide command, Vitest coverage note + screenshot placeholder, Vitest source-save limitation. Core README (framework-neutral), developer guide (Pages setup, roadmap, limitation row), ai-context (command, key files). `architecture.md` / runner README already covered Vitest (phases 1–5).
**11.2 Real-repo validation & fixes (3 d buffer, per release)** — Jest and Vitest repos; findings into `docs/bugs-and-issues.md`.
Done (2026-10-22): `e2e/real-repos.js --all`: jest-dom, vscode-jest, sample-react-project, unplugin, slidev, vueuse PASS; the heavy `jest` monorepo FAILS only the results comparison, exactly BUG-43 (23 files, all jest-runtime's own tests + `intro.test.js` + one flaky `watch.test.js` test; extension 4149/1126 vs plain 4273/1002 — phase-1 gate had 4141/1122, plain Jest flakes ±1) — every other check passes (trace, coverage, ▶ Run, save via trace, debug, timeline, Stop). Found in 5.3: the coverage exclusion bug (fixed). BUG-43 note updated.
**11.3 Release prep (0.5–1 d per release)** — version check, e2e against the packed `.vsix` (`LTR_E2E_EXTENSION_DIR`), PR `release/x` → `main` (the PR is opened by the owner, D9).
Done (2026-10-22): version 3.0.0 in root + extension `package.json`, both CHANGELOGs under `[3.0.0] - Unreleased` (owner sets the date when releasing); `vsce package --no-dependencies` → 37 files / 281 KB (out/extension.js, out/guide, out/instrumentation, out/vendor, src/webview); unpacked and `LTR_E2E_EXTENSION_DIR=<unpacked>/extension node e2e/run.js --all` → 25/25 (22 pass, 3 repo scenarios skipped). Left to the owner: merge the feature branches into `release/3.0.0`, open the `release/3.0.0` → `main` PR, enable GitHub Pages (Settings → Pages → Source: GitHub Actions).
**11.4 Guide on GitHub Pages + "Open Guide" command (1 d, part of 3.0.0, D10)** — Pages workflow publishing `docs/live-test-runner-guide.html` as the docs site; README link; command `liveTestRunner.openGuide` opening the guide.
Done (2026-10-22): `.github/workflows/pages.yml` (push to `main` touching the guide, or manual: copies it to `_site/index.html`, `configure-pages@v5` / `upload-pages-artifact@v3` / `deploy-pages@v4`) → https://eshandias.github.io/live-test-runner/ once Pages is enabled with source "GitHub Actions". Command **Open Guide** (`views/GuidePanel.ts`): `esbuild.js` copies the guide to `out/guide/guide.html` (in the .vsix, offline, version-matched), shown in a webview with a nonce CSP so its theme toggle / nav script runs; one tab (reveals on repeat); no copy (dev build) → opens the online guide. Unit `test/guidePanel.test.ts`, e2e `guide-open` (also passes on the packed .vsix).

## 7. Totals

| Phase | Feature / release | Tasks | Days |
|---|---|---|---|
| 0 | Housekeeping — **3.0.0** | 3 | 2.5 |
| 1 | Decouple from Jest — **3.0.0** | 6 | 9 |
| 2 | Vitest run & pass/fail (V1) — **3.0.0** | 8 | 15 |
| 3 | Logs & output (V2) — **3.0.0** | 3 | 4.5 |
| 5 | Coverage (V4) — **3.0.0** | 3 | 4.5 |
| 11.1–11.3 | Matrix, guide, validation, release — **3.0.0** | 3 | 6.5 |
| | **3.0.0 total** | **26** | **≈ 42 d** |
| 4, 6 | Live streaming, on-save related — 3.0.x | 6 | 9.5 |
| 7 | Monorepos / multi-project — 3.1 | 7 | 17 |
| 8 | Mixed frameworks — 3.2 | 6 | 13 |
| 9 | Execution trace — 3.3 | 4 | 10 |
| 10 | Timeline — 3.4 | 3 | 8 |
| | Per-release prep for the 5 later releases (11.3) | 5 | 3 |
| | **Everything** | **57** | **≈ 103 d** |

M1 (inside 3.0.0) = phases 0–2: Vitest runs and shows pass/fail (≈ 26 d).
(The first chat estimate covered only “Stage 1”; this breakdown includes cross-platform e2e, tests for every feature, docs, and the later releases.)

## 8. Risks

| Risk | Mitigation |
|---|---|
| Phase 1 refactor regresses Jest/CRA/Windows | Small commits, gate after each, snapshot arg tests, real-repo matrix |
| Vitest reporter API unstable across majors | Version matrix in fixtures; thin reporter; capability flags per version |
| No per-test console output in Vitest | File-level fallback is already the documented rule |
| Missing coverage provider | Detect and guide, never fail silently |
| Browser-mode projects (vueuse) need Playwright browsers | Excluded by default, explained in the log |
| Test scripts with pre-steps (unplugin `test:build`) | Compare against plain `vitest run`; document prerequisites |
| Vitest 5 needs Node ≥ 22.12 vs Electron fallback runtime | Detect and explain; prefer PATH node |
| Windows path/case quirks (8.3 short paths, drive letters) | Reuse `JestPaths` rules via renamed helpers; CI matrix |
| Phase 7 touches the single-root assumption everywhere | Own spike + ADR first; contexts introduced behind the services bundle from phase 1 |

## 9. Remaining open questions

- None. (Q5 answered → D10 / task 11.4; phase 7/8/9 questions answered → D11–D14.)

## Handoff — where work stopped (2026-10-20)

**Branches**
- `release/3.0.0` — includes PR #34 (`feat/vitest-housekeeping`: 0.2 workflows + 0.3 harness), so CI on `pnpm/setup@v3` ran green on all three OSes.
- `feat/vitest-decouple` (from `release/3.0.0` @ `e2ba4ae`, pushed to origin) — 0.3 follow-ups, task 1.1, CHANGELOG clean-up (entries that shipped in 2.0.4 moved out of Unreleased; `[3.0.0] - Unreleased` header), task 1.2. Phase 1 continues on this branch; one PR into `release/3.0.0` at the end of phase 1.

**Done in this session**
- 0.3 finished: `e2e/real-repos.js` records each repo's plain-runner per-file counts + extension match in `docs/temp_plans/vitest-baseline.json` (CRA gets a baseline too). Fixed `repo-cra`'s plain run for workspaces under macOS's `/var` symlink (it passed `/var/…` to `--runTestsByPath`; Jest only accepts `/private/var/…`). Baseline green: `jest-dom` 31 files, `vscode-jest` 49 files / 2012 tests, `sample-react-project` 14 files. The heavy `jest` monorepo: see below.
- **Phase 1 done (1.1–1.6)** — see the task notes below. Phase gate (after 1.6): build, lint, 63 runner + 17 extension unit tests, `e2e/run.js --all` (11 pass, 2 repo scenarios skipped), real repos jest-dom / vscode-jest / CRA PASS; `jest` monorepo: first run hit BUG-44 (race, fallback recovered), rerun identical to the pre-refactor build (6194 · 4141 passed · 1122 failed; only BUG-43 differs).
- 1.1–1.4 notes: Gate after 1.4: unit tests, e2e --all (11 pass, 2 skipped), real-repos (3/3) green. Note: commit `b175e39` (1.3) accidentally carries the `SessionTraceRunner.ts → JestBatchRunner.ts` file rename without the import updates, so it does not build on its own; the 1.4 commit fixes it. Gate after 1.3: unit tests (53 runner + 17 extension), e2e --all, real-repos (3/3) green.
- `jest` monorepo (`node e2e/real-repos.js jest`, after 1.2): harness fixed (spawnSync 1 MB buffer killed the plain-Jest baseline; save-test source picked from `packages/*`). 470/484 files match plain Jest; the rest are **BUG-43** (jest-runtime tests fail under the session run, `docs/bugs-and-issues.md`). The pre-refactor build (`e2ba4ae`) gives identical totals (6194 tests · 4141 passed · 1122 failed), so 1.1/1.2 changed nothing; BUG-43 is a 2.0.4 issue, open. Every other check passes on the monorepo.
- Gate after 1.2: `pnpm build`, `pnpm lint`, `pnpm test` (47 runner incl. 4 command-line snapshots + 17 extension), `node e2e/run.js --all` (11 pass, 2 skipped), `node e2e/real-repos.js` (3/3 PASS).
- Gate after 1.1: `pnpm build`, `pnpm lint`, `pnpm test` (35 runner + 17 extension), `node e2e/run.js --all` (11 pass, 2 repo scenarios skipped — covered by `real-repos.js`), `node e2e/real-repos.js` (3/3 PASS, originals untouched).

**Phase 2 (branch `feat/vitest-run`, from `release/3.0.0` after PR #35 merged)**
- 2.1 done (2026-10-21) — see the task note. Gate: build, lint, 88 runner + 17 extension unit tests, `e2e/run.js --all` (11 pass, 2 repo scenarios skipped), `e2e/real-repos.js` (jest-dom, vscode-jest, sample-react-project PASS; Vitest repos skip until the `repo-vitest` scenario lands in 2.7). The heavy `jest` monorepo was not rerun — 2.1 only changes Vitest detection and adds a guard Jest projects never reach.

- 2.2 done (2026-10-21) — see the task note. Gate: build, lint, 115 runner + 17 extension unit tests, `e2e/run.js --all` (11 pass, 2 repo scenarios skipped), `e2e/real-repos.js` (jest-dom, vscode-jest, sample-react-project PASS); real-Vitest checks on unplugin and vueuse clones.

- 2.3 done (2026-10-21) — see the task note. Gate: build, lint, 157 runner + 17 extension unit tests, `e2e/run.js --all` (11 pass, 2 repo scenarios skipped), `e2e/real-repos.js` (jest-dom, vscode-jest, sample-react-project PASS).

- 2.4 done (2026-10-21) — see the task note. Gate: lint, 157 runner + 17 extension unit tests, `e2e/run.js --all` (12 pass incl. `vitest-full-run`, 2 repo scenarios skipped), `e2e/real-repos.js` (jest-dom, vscode-jest, sample-react-project PASS).

- 2.5 done (2026-10-21) — see the task note. Gate: lint, 157 runner + 29 extension unit tests, `e2e/run.js --all` (12 pass, 2 skipped), `e2e/real-repos.js` (3/3 PASS).

- 2.6 done (2026-10-21) — see the task note. Gate: lint, 157 runner + 29 extension unit tests, `e2e/run.js --all` (15 pass incl. 4 Vitest scenarios, 2 skipped), `e2e/real-repos.js` (3/3 PASS).

- 2.8 done (2026-10-21) — see the task note. Gate: build, lint, 162 runner + 29 extension unit tests, `e2e/run.js --all` (15 pass, 2 skipped), `e2e/real-repos.js` (3/3 PASS).

- 2.7 done (2026-10-21) → **M1** (Vitest run & pass/fail). Phase 2 complete on `feat/vitest-run`. Gate: lint, 162 runner + 29 extension unit tests, `e2e/run.js --all` (17 pass incl. 6 Vitest scenarios, 3 repo scenarios skipped — run by real-repos.js), `e2e/real-repos.js` (6/6 PASS: jest-dom, vscode-jest, sample-react-project, unplugin, slidev, vueuse).

**Phase 3 (branch `feat/vitest-logs`, from `feat/vitest-run`)**
- 3.1 done (2026-10-21) — see the task note. Gate: build, lint, 164 runner + 29 extension unit tests, `e2e/run.js --all` (18 pass, 3 repo scenarios skipped), `e2e/real-repos.js` (6/6 PASS).

- 3.2 done (2026-10-21) — see the task note. Gate: build, lint, 168 runner + 29 extension unit tests, `e2e/run.js --all` (18 pass, 3 skipped), `e2e/real-repos.js` (6/6 PASS).

- 3.3 done → **M2a**. Phase 3 complete on `feat/vitest-logs`.

**Phase 4 (branch `feat/vitest-live`, from `feat/vitest-logs`)** — live per-file streaming (3.0.x scope, done now at the owner's request), then phase 5 (coverage) on `feat/vitest-coverage`.

- 4.1 done (2026-10-21) — see the task note. Gate: build, lint, 169 runner + 29 extension unit tests, `e2e/run.js --all` (18 pass, 3 skipped), `e2e/real-repos.js` (6/6 PASS).

- 4.2 done (2026-10-21) — see the task note. Gate: build, lint, 169 runner + 29 extension unit tests, `e2e/run.js --all` (20 pass incl. 10 Vitest scenarios, 3 skipped), `e2e/real-repos.js` (6/6 PASS — vueuse / slidev / unplugin through the live batch runner).

- 4.3 done → **M2b**. Phase 4 complete on `feat/vitest-live`.

**Phase 5 (branch `feat/vitest-coverage`, from `feat/vitest-live`)**

- 5.1 + 5.2 done (2026-10-21) — see the task note. Gate: build + lint OK; unit 177 runner + 29 extension; e2e 24/24; real repos all PASS (jest-dom, vscode-jest, CRA, unplugin, slidev, vueuse).

- 5.3 done (2026-10-22) → **M3a**. Phase 5 complete. Gate: build, lint, 180 runner + 38 extension unit tests, `e2e/run.js --all` (24/24: 21 pass, 3 repo scenarios skipped), `e2e/real-repos.js --fresh` (6/6 PASS: jest-dom, vscode-jest, sample-react-project, unplugin, slidev, vueuse).

**Phase 11 (branch `feat/vitest-release-docs`, from `feat/vitest-coverage-tests`)**
- 11.1–11.4 done (2026-10-22) → **3.0.0 ready for the owner's release PR**. Gate: build, lint, 180 runner + 39 extension unit tests, e2e on the packed .vsix 25/25, `e2e/real-repos.js --all` 6/7 PASS (jest monorepo: BUG-43 only, unchanged).

**Next**
1. Phase 6 (related tests on save) on `feat/vitest-related`, then 7 → 8 → 9 (D9).

## Progress tracker

- [x] 0.1 Release branch + version (done: `release/3.0.0` cut from main@2.0.4, version 3.0.0 in root + extension)
- [x] 0.2 Workflows → pnpm/setup@v3 (CI green on PR #34)
- [x] 0.3 Baseline + real-repo harness (`e2e/real-repos.js`; baseline in `vitest-baseline.json`; 3 light Jest repos green; `jest` monorepo green except pre-existing BUG-43)
- [x] 1.1 Neutral naming & open types
- [x] 1.2 Generic runner layer
- [x] 1.3 FrameworkRegistry + detector
- [x] 1.4 IBatchRunner + services bundle
- [x] 1.5 Split instrumentation
- [x] 1.6 Conformance suite + gate
- [x] 2.1 Runner VitestAdapter
- [x] 2.2 VitestRunner
- [x] 2.3 Result parsing
- [x] 2.4 Extension VitestAdapter
- [x] 2.5 Static discovery syntax
- [x] 2.6 Session behaviour parity
- [x] 2.8 Projects & browser-mode guard
- [x] 2.7 Tests (M1)
- [x] 3.1 Output capture
- [x] 3.2 Failure details & diagnostics
- [x] 3.3 Tests
- [x] 5.1 Coverage run
- [x] 5.2 Coverage mapping
- [x] 5.3 Tests (M3a)
- [x] 11.1 Feature matrix + guide
- [x] 11.2 Real-repo validation
- [x] 11.3 Release prep → **3.0.0** (release PR by the owner)
- [x] 11.4 Guide on GitHub Pages + Open Guide command (D10)
- [x] 4.1–4.3 Live streaming (3.0.x)
- [ ] 6.1–6.3 Related/on-save (3.0.x)
- [ ] 7.1–7.7 Monorepos (3.1)
- [ ] 8.1–8.6 Mixed (3.2)
- [ ] 9.1–9.4 Trace (3.3)
- [ ] ~~10.1–10.3 Timeline~~ — deferred, separate release (D9)
