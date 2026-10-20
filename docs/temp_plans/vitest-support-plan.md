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

### Release roadmap

| Release | Scope | Phases |
|---|---|---|
| **3.0.0** | Decouple + Vitest single project: run, pass/fail, logs, coverage; feature matrix | 0, 1, 2, 3, 5, 11.1 |
| 3.0.x | Live per-file streaming, source-file on-save (related tests) | 4, 6 |
| 3.1.0 | Monorepos / multi-project workspaces | 7 |
| 3.2.0 | Mixed-framework projects | 8 |
| 3.3.0 | Execution trace for Vitest | 9 |
| 3.4.0 | Timeline debugger for Vitest | 10 |

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

**1.3 `FrameworkRegistry` + detector (0.5 d)** (C7)
Sketch: `ADAPTER_PRIORITY` becomes a registry (`register(adapter, priority)`); detector returns `{adapter, reason}`; unknown project → explicit `unknown` result with the existing Jest fallback kept (logged at WARN), so behaviour is unchanged.

**1.4 Extract `IBatchRunner` + services bundle (3 d)** (C1, C3, C4, C5)
Sketch: define `IBatchRunner { runFiles(opts), kill(), reset(), … }` from `SessionTraceRunner`'s public surface; `JestBatchRunner = today's SessionTraceRunner`. Introduce `FrameworkServices` and have `SessionManager` take `servicesFor(file|root)` (single provider returning the one Jest bundle for now) — replacing the constructor's `_adapter` + `_projectConfig`, `new SessionTraceRunner`, and `new JestRunner` bootstrap (`TestSession` gets `adapter.createRunner()`). `extension.ts` composes services; `IInstrumentedRunner` is produced by the services bundle too.
Risk: largest refactor; do it in small commits, run the gate after each.

**1.5 Split instrumentation (1 d)** (C3)
Sketch: `session/instrumentation/` → `shared/` (trace record format, writer protocol, doc of the `__strace` contract), `jest/` (transform, reporter, setup, discovery). Pure file moves + import updates; document the protocol in `docs/architecture.md` so Vitest can implement it later.

**1.6 Conformance suite + gate (1.5 d)**
Sketch: `packages/runner/test/adapterConformance.ts` — a reusable suite every adapter must pass (detect true/false cases, arg shape, parse a canned result, kill behaviour); apply to Jest and CRA. Run the full regression gate. Add a "Adding a framework" checklist to `docs/developer-guide.md`.
Done when: gate green, `git grep -i jest` in `SessionManager`, `extension.ts`, `core/` shows only the Jest bundle wiring.

### Phase 2 — Vitest: run & pass/fail (15 d) — *Feature V1*

**2.1 Runner `VitestAdapter` (1.5 d)** (replaces the `ViteAdapter` stub)
Sketch: `detect` keeps BUG-37 rule (Vitest only when nothing marks the project as Jest — until mixed support, task 7.x relaxes this); resolve binary from `node_modules/vitest/package.json#bin` → `vitest.mjs` (no `.bin` shim → works on Windows); read the installed Vitest version → capability flags per version (baseline ≥ 3; < 3 best-effort: JSON run/parse works, `vitest list`/`related` fall back to glob scan / `--changed`, live reporter needs the legacy shim in 4.1); `resolveConfig`: `vitest.config.*` > `vite.config.*`, else undefined; Node-version check with a friendly error for v5 (Node ≥ 22.12) when only the Electron fallback runtime exists.

**2.2 `VitestRunner` (2 d)**
Sketch: command shapes — full: `vitest run --reporter=json --outputFile=<tmp> --root <root> [--config c] --passWithNoTests`; file(s): positional paths; test case: `-t '<escaped>'`; `CI=1` + `--watch=false`; never `--ui`. Reuse `CommandRunner`; spawn with `node vitest.mjs` (no shell), same path normalisation rules as Jest where relevant. User override `liveTestRunner.vitestCommand` (shell-quoted like `jestCommand`). Always pass `--reporter` explicitly so a config `reporters: 'dot'` (vueuse) cannot swallow our JSON; honour config-affecting flags from the project's `test` script (`--config`, `--project`, `--root`) like `testScriptJestArgs` does for Jest.

**2.3 Result parsing (1.5 d)**
Sketch: map Vitest JSON → `RunResult/FileRunResult`: status mapping (`passed/failed/skipped/pending/todo`), `ancestorTitles`, `location`, `failureMessages` (ANSI-strip), file-level collection errors (no assertionResults + `message`) → file failed; `.each` titles → existing template handling. Store canned JSON from Vitest 1.x…5.x as fixtures.

**2.4 Extension `VitestAdapter` (3 d)**
Sketch: implements `IFrameworkAdapter`: `discoverTests` (`vitest list --filesOnly --json`, fallback to include-glob scan), `getFileGlob/isTestFile` from config `include`/defaults (`**/*.{test,spec}.?(c|m)[jt]s?(x)`), `runFile`, `applyFileResult`, `runTestCase`, `getDebugConfig` (node launch of `vitest.mjs run <file> -t … --no-file-parallelism --test-timeout=0`), `getAffectedTests` (coverage map; real impl phase 6), `runRelatedTests` (stub → phase 6, "not available" capability until then).

**2.5 Static discovery syntax (1.5 d)**
Sketch: check `TestDiscoveryService`'s parser covers `test/it/describe` + `.skip/.only/.todo/.concurrent/.each/.for/.skipIf/.runIf`, `test.extend` fixtures, `import { test } from 'vitest'`; add missing forms and unit tests.

**2.6 Session behaviour parity (1 d)**
Sketch: confirm Start/Stop/hang detection/on-save-without-trace/session guard work through the plain-run path (`SessionManager` ~line 802) with Vitest; `Stop` is final; capability `trace=false` → timeline/“Covering tests” show “not available for Vitest yet”.

**2.8 Vitest `projects` & browser-mode guard (1.5 d)**
Sketch: run from the root config once — Vitest fans out over `test.projects` itself (slidev, vueuse). Browser-mode projects (Playwright/WebdriverIO, e.g. vueuse `browser`) are excluded by default (`--project '!<name>'` resolved from `vitest list`/config; setting `liveTestRunner.vitestIncludeBrowserProjects`), with an INFO line explaining. Test results carry the project name for later display (phase 7). Honour `--project` in the user's `test` script when present.

**2.7 Tests (3 d)**
- Unit: adapter detect matrix (vitest only / jest only / both / neither / `jest-dom` shape), arg builders, parser fixtures per version, registry.
- Fixtures: `e2e/fixtures/vitest-basic` (+ later `vitest-ts`, `vitest-esm`), scenarios `vitest-full-run`, `vitest-scoped-run`, `vitest-stop`, `vitest-hang`, `vitest-on-save`, `vitest-debug`.
- Add `unplugin`, `slidev`, `vueuse` to the repo matrix (compare with plain `vitest run`; vueuse with browser projects excluded).
Gate → **tag milestone M1** (Vitest run & pass/fail).

### Phase 3 — Logs & output (4.5 d) — *Feature V2*

**3.1 Output capture (2 d)** — spike first: does `onUserConsoleLog` give per-test attribution? If yes, document it as a Vitest improvement; otherwise keep the file-level rule (never back-fill). Run with `--reporter=default --reporter=json` (+ `--outputFile.json=`) so raw stdout streams to the Test Output channel and Results pane.
**3.2 Failure details & inline diagnostics (1.5 d)** — parse Vitest stack frames (strip `vite-node`/`❯` noise, map `file:line:col`), use `location` for the test line, feed `utils/diagnostics.ts`.
**3.3 Tests (1 d)** — scoped output rerun e2e (`vitest-output`), unit tests for stack parsing.
Gate → **M2a**.

### Phase 4 — Live per-file streaming & batch (6.5 d) — *Feature V3*

**4.1 Live reporter (3 d)** — ESM reporter module (`instrumentation/vitest/liveReporter.mjs`) appending `FileRunResult` JSON lines to `LTR_REPORTER_FILE` on `onTestModuleEnd`, start records on `onTestModuleStart`; compatibility shim for the older `onFinished/onTaskUpdate` API if cheap (D2). Loaded with `--reporter=<abs path>`.
**4.2 `VitestBatchRunner` (2 d)** — implements `IBatchRunner` without trace: one process per batch, hang detection from start records, kill process tree, `--no-file-parallelism` never forced.
**4.3 Tests (1.5 d)** — `vitest-batch`, `vitest-save-during-run`, reporter unit tests with synthetic events.
Gate → **M2b**.

### Phase 5 — Coverage (4.5 d) — *Feature V4*

**5.1 Coverage run (2 d)** — `--coverage.enabled --coverage.reporter=json --coverage.reporter=json-summary --coverage.reportsDirectory=<session>/cov`; provider detection (`@vitest/coverage-v8`/`-istanbul` present?) → if missing, an actionable message (“install @vitest/coverage-v8”) instead of a failed run; set `coverage.include` to the source globs so uncovered files show; handle v5 root-relative include/exclude.
**5.2 Map into `CoverageStore`/`CoverageMap` (1 d)** — normalise paths; confirm json is istanbul-shaped for both providers; thresholds and gutter/hover unchanged (they read the store).
**5.3 Tests (1.5 d)** — `vitest-coverage` e2e, missing-provider path, unit tests on the mapping.
Gate → **M3a**.

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
**11.2 Real-repo validation & fixes (3 d buffer, per release)** — Jest and Vitest repos; findings into `docs/bugs-and-issues.md`.
**11.3 Release prep (0.5–1 d per release)** — version check, e2e against the packed `.vsix` (`LTR_E2E_EXTENSION_DIR`), PR `release/x` → `main`.

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

- **Q5** — HTML guide (`docs/live-test-runner-guide.html`): my suggestion is to publish it with GitHub Pages as the project’s docs site, link it from the marketplace README, and add a “Open Guide” command that opens it in a webview — it is clearer than a long README. Want that as a task?

## Handoff — where work stopped (2026-10-20)

**Branches**
- `release/3.0.0` — includes PR #34 (`feat/vitest-housekeeping`: 0.2 workflows + 0.3 harness), so CI on `pnpm/setup@v3` ran green on all three OSes.
- `feat/vitest-decouple` (from `release/3.0.0` @ `e2ba4ae`, **local, not pushed**) — commit 1: 0.3 follow-ups; commit 2: task 1.1. Phase 1 continues on this branch; PR into `release/3.0.0` when phase 1 is done (or earlier, if the owner prefers smaller PRs).

**Done in this session**
- 0.3 finished: `e2e/real-repos.js` records each repo's plain-runner per-file counts + extension match in `docs/temp_plans/vitest-baseline.json` (CRA gets a baseline too). Fixed `repo-cra`'s plain run for workspaces under macOS's `/var` symlink (it passed `/var/…` to `--runTestsByPath`; Jest only accepts `/private/var/…`). Baseline green: `jest-dom` 31 files, `vscode-jest` 49 files / 2012 tests, `sample-react-project` 14 files. The heavy `jest` monorepo has **not** been run yet (`node e2e/real-repos.js jest`).
- 1.1 done — see the task notes below.
- Gate after 1.1: `pnpm build`, `pnpm lint`, `pnpm test` (35 runner + 17 extension), `node e2e/run.js --all` (11 pass, 2 repo scenarios skipped — covered by `real-repos.js`), `node e2e/real-repos.js` (3/3 PASS, originals untouched).

**Next**
1. Task 1.2 (generic runner layer) on `feat/vitest-decouple`.
2. Optional: one run of `node e2e/real-repos.js jest` for the monorepo baseline.

## Progress tracker

- [x] 0.1 Release branch + version (done: `release/3.0.0` cut from main@2.0.4, version 3.0.0 in root + extension)
- [x] 0.2 Workflows → pnpm/setup@v3 (CI green on PR #34)
- [x] 0.3 Baseline + real-repo harness (`e2e/real-repos.js`; baseline in `vitest-baseline.json`; 3 light Jest repos green, `jest` monorepo still to run)
- [x] 1.1 Neutral naming & open types
- [ ] 1.2 Generic runner layer
- [ ] 1.3 FrameworkRegistry + detector
- [ ] 1.4 IBatchRunner + services bundle
- [ ] 1.5 Split instrumentation
- [ ] 1.6 Conformance suite + gate
- [ ] 2.1 Runner VitestAdapter
- [ ] 2.2 VitestRunner
- [ ] 2.3 Result parsing
- [ ] 2.4 Extension VitestAdapter
- [ ] 2.5 Static discovery syntax
- [ ] 2.6 Session behaviour parity
- [ ] 2.8 Projects & browser-mode guard
- [ ] 2.7 Tests (M1)
- [ ] 3.1 Output capture
- [ ] 3.2 Failure details & diagnostics
- [ ] 3.3 Tests
- [ ] 5.1 Coverage run
- [ ] 5.2 Coverage mapping
- [ ] 5.3 Tests
- [ ] 11.1 Feature matrix + guide
- [ ] 11.2 Real-repo validation
- [ ] 11.3 Release prep → **3.0.0**
- [ ] 4.1–4.3 Live streaming (3.0.x)
- [ ] 6.1–6.3 Related/on-save (3.0.x)
- [ ] 7.1–7.7 Monorepos (3.1)
- [ ] 8.1–8.6 Mixed (3.2)
- [ ] 9.1–9.4 Trace (3.3)
- [ ] 10.1–10.3 Timeline (3.4)
