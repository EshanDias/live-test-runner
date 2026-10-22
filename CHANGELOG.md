# Changelog

All notable changes to Live Test Runner are documented here.

## [3.0.0] - Unreleased

### Bug Fixes

- **Live run timer updates every second** — the running file-count timer now advances while files are running, and displays elapsed time in the correct units.
- **File durations use whole milliseconds** — fractional millisecond values are rounded; durations of a second or more omit the millisecond remainder.
- **Coverage totals follow the project's coverage config** — the totals (and the source scan that adds untouched files at 0%) used fixed built-in rules over every `*.{js,ts,jsx,tsx}` in the workspace, ignoring the project's own settings. Generated files such as Vitest's html-reporter bundle (`.vitest/ui/assets/index-*.js`, ~14k statements) and `public/` scripts landed in the denominator, roughly halving the percentage against `vitest run --coverage`. New `coverage/coverageScope.ts`: a `CoverageScope` per framework, exposed as `IProjectConfig.coverageScope(root)`:
  - **Vitest** — the resolved `coverage.include` / `exclude` (Vitest's defaults merged) and, below Vitest 4, `all`, read by the existing config probe (`vitestConfigInfo` now also returns `coverage`).
  - **Jest** — `collectCoverageFrom`, `coveragePathIgnorePatterns`, test files (`testMatch` / `testRegex`), setup files and `__mocks__` — the rules of Jest's `shouldInstrument` — from the `--showConfig` read the session already does (`ResolvedProjectConfig.coverage`).
  - Untouched files are added only when the config lists the files to cover (Vitest `include`, Jest `collectCoverageFrom`); otherwise, like the CLI, only loaded files count and the scan is skipped.
  - The same scope filters measured files in both batch runners (`applyIstanbulCoverage` takes a `counts` predicate). When the config cannot be read, the built-in rules apply as before, and the scan also skips git-ignored files (`git check-ignore`).
  - Glob matching uses `picomatch` (bundled), with micromatch-style `!` negation.
- **Coverage % / N/M toggle updates the totals** — the toggle re-rendered only the file table; the Project totals row (and the Tests-panel badge) kept the old format until the next coverage update. `testListView.js` now keeps the last totals and re-renders them on toggle.

### Framework decoupling (Vitest support, phase 1)

- **Neutral naming and open framework ids (task 1.1)** — `Framework` (closed union `'jest' | 'cra' | 'next' | 'vite' | 'unknown'`) is now `FrameworkId = string` with the shipped ids in `FRAMEWORK_IDS`; `Framework` stays as a deprecated alias. `toJestPath` / `fromJestPath` → `toRunnerPath` / `fromRunnerPath` (`resolution/JestPaths.ts` → `RunnerPaths.ts`; old names kept as deprecated aliases for one release). `PLAIN_RUN_HANG_FACTOR` moved from the Jest adapter to the extension's `constants.ts`. `ProjectJestConfig` → `JestProjectConfig` implementing the new `IProjectConfig` interface, which `SessionManager`, `SessionTraceRunner` and `JestInstrumentedRunner` now depend on.
- **Generic runner layer (task 1.2)** — new abstract `CommandRunner` holds everything that is not Jest-specific (adapter per project root, binary / user-command prefix / `--config` / adapter extra args, Windows command-line chunking, file timeout, kill, coverage file); `JestRunner` now only builds Jest's args per run kind (`buildArgs({ kind: 'list' | 'full' | 'files' | 'testCase' | 'related' })`) and parses `--listTests`. `FrameworkAdapter` gains `outputFileArg(file)`, `parseResult(passed, raw, stderr)` and `createRunner(options)` (Jest + CRA: `--outputFile=`, `ResultParser`, `JestRunner`; the Vite stub throws "not supported"). `Executor.runWithJsonCapture(command, outputFileArg)` takes the result-file flag instead of hard-coding `--outputFile`. `emptyRunResult` / `mergeRunResults` moved out of the Jest parser. `FrameworkDetector` builds its adapter list on first use (adapters now import their runners). Snapshot tests pin the Jest command lines — unchanged.
- **`FrameworkRegistry` (task 1.3)** — the detector's fixed adapter list is now a registry (`register(adapter, priority)`, `unregister`, `get`; `FrameworkRegistry.default()` = CRA 300 → Vite 200 → Jest 100, same order as before). `FrameworkDetector` takes a registry and gains `detectWithReason()` (`{ adapter, framework, matched, reason }`). A project no adapter recognises still runs as plain Jest, but now logs one WARN per project root instead of a DEBUG line; the diagnostic report shows the reason.
- **Batch runner interface + framework services bundle (task 1.4)** — `IBatchRunner` (`runFiles(BatchRunOptions)`, `kill`, `reset`) is extracted from the session's batch runner, which is renamed `SessionTraceRunner` → `JestBatchRunner`. New `FrameworkServices` bundle (`adapter`, `projectConfig`, `batchRunner`, `instrumentedRunner`, `createSessionRunner()`) and `IFrameworkServicesProvider` (`servicesFor(fileOrRoot)`, `all()`; `SingleFrameworkProvider` for now). `SessionManager` takes the provider instead of the adapter + project config, and no longer constructs `SessionTraceRunner` or `JestRunner` (core's `TestSession` gets `createSessionRunner()`, i.e. the runner `JestAdapter.createRunner()`). `extension.ts` composes the Jest bundle (`createJestServices`); the Jest command setting is read by one helper (`jestCommandSetting`).
- **Instrumentation split (task 1.5)** — `session/instrumentation/` is now `shared/` (`sessionTraceRuntime.js`, `testDiscovery.js` — framework-neutral) and `jest/` (`sessionTraceTransform.js`, `ltrCoverageSetup.js`, `liveReporter.js`); `out/instrumentation/` mirrors the layout. The contract between them (`__strace` API, trace / coverage / per-file record formats, environment variables) is documented in `docs/architecture.md` → *Session instrumentation protocol*. File moves and path updates only; because the transform's own source changed, the persistent transform cache is rebuilt once on the first Start.
- **Adapter conformance suite + phase 1 gate (task 1.6)** — `packages/runner/test/adapterConformance.ts`: a reusable suite every `FrameworkAdapter` must pass (registered id, claims its projects and no others, result-file flag, canned result with a passing and a failing test, unreadable output → failed result, the created runner passes the file and the adapter's result-file flag, kill is safe), applied to Jest and CRA. The services bundle gains `displayName` and `settingsFingerprint()`, so `SessionManager` no longer reads Jest settings or names Jest in code (log wording is unchanged for Jest projects). "Adding a framework" checklist in the developer guide.
- **"Jest Output" → "Test Output"** — the raw output channel is now **Live Test Runner: Test Output** and the command **Show Test Output** (same id, `liveTestRunner.showOutput`); lines keep their `[jest#N]` tag.

### Docs, guide & release prep (phase 11)

- **Marketing website + SEO** — new landing page `site/index.html` (hero with install buttons for the VS Code Marketplace and Open VSX, feature grid, screenshots, quick start, framework table, review links, FAQ) served at https://eshandias.github.io/live-test-runner/; the guide moves to `/guide/` (`GuidePanel.GUIDE_URL` and the README link updated). SEO: meta description, canonical, Open Graph / Twitter cards, JSON-LD `SoftwareApplication` + `FAQPage`, `site/sitemap.xml`; the guide gets a description, canonical and OG tags. The Pages workflow now assembles `_site/` from `site/`, the guide and `resources/images/*.png`, and also runs when those change, on `main` and on `release/*` branches. Reviews link to each marketplace's review page (posting needs sign-in there). Extension `package.json` gains `keywords`, `homepage` and `bugs` for marketplace search.
- **Open Guide command + guide on GitHub Pages (task 11.4)** — new command **Live Test Runner: Open Guide** (`liveTestRunner.openGuide`, `views/GuidePanel.ts`) shows the user guide in an editor tab: `esbuild.js` copies `docs/live-test-runner-guide.html` to `out/guide/guide.html` (shipped in the .vsix, works offline, matches the installed version); the page's scripts run under a nonce CSP; a missing copy (dev build) opens the online guide instead. `.github/workflows/pages.yml` publishes the same file to GitHub Pages (https://eshandias.github.io/live-test-runner/) when it changes on `main` — needs Settings → Pages → Source "GitHub Actions" once. The guide's links to `bugs-and-issues.md` / `architecture.md` / `developer-guide.md` are absolute GitHub URLs so they work on Pages and in the tab. README links the guide. Unit test `test/guidePanel.test.ts`, e2e `guide-open`.
- **Guide refresh (task 11.1)** — new *Vitest* section (detection, versions, config flags, per-test output, failures, coverage provider, projects / browser guard, what is not there yet); Jest-only wording made framework-neutral (overview, quick start, Stop, Test Output); Debugging describes the Vitest launch and drops the BUG-05 / BUG-06 warning (both fixed); hover and Timeline say what Vitest lacks; *Known issues* lists the open bugs (BUG-43, BUG-44) instead of fixed ones; Open Guide in the commands table. Matrix: the Vitest Timeline cell is "⏳ later" (deferred, plan D9). README: guide link, Open Guide command, Vitest coverage note and screenshot placeholder; core README says the package is framework-neutral; developer guide (Pages setup, roadmap, known limitations), ai-context (command, key files) updated.
- **Release checks (tasks 11.2, 11.3)** — version 3.0.0 in both package.json files; the e2e suite runs against the packed `.vsix` (`vsce package --no-dependencies`, unpacked, `LTR_E2E_EXTENSION_DIR`); real-repo matrix incl. the Jest monorepo.

### Vitest support (phase 5 — coverage)

- **Coverage tests (task 5.3)** — unit tests for the istanbul → CoverageStore mapping (`test/istanbulCoverage.test.ts`: manifest shape incl. older-provider entries without `decl` / branch `loc`, percentages, max-merge of the same file version, a changed file starting over, a source-scan count replaced by the measurement, exclusions); the extension's unit tests map `vscode` to a small stub (`test/vscodeStub.ts`) so store / coverage modules load. `repo-vitest` checks coverage on the real repos: measured when the project has a provider package (vueuse), otherwise exactly one "coverage is off" line and nothing measured (unplugin, slidev), and no `coverage/` folder written. **Fix (any framework):** files in top-level `test/`, `tests/`, `__tests__/`, `__mocks__/`, `dist/`, `build/`, `out/` or `coverage/` folders were measured as source — the exclusion rules got a project-relative path but needed a leading separator.
- **Vitest coverage (tasks 5.1, 5.2)** — session batches measure coverage with Vitest's own provider: the project probe now also reads `coverage.provider`; when its package (`@vitest/coverage-v8` / `-istanbul`) is installed, `VitestRunner.liveCommand(files, { coverageDir })` adds `--coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory=<session>/vitest-coverage/<batch> --coverage.reportOnFailure=true` (plus `--coverage.all=false` below Vitest 4, which would otherwise instrument the whole project); otherwise one INFO line says what to install. `coverage/istanbulCoverage.ts` maps `coverage-final.json` into the CoverageStore — one manifest per file version (hash of path + maps; same counters model as the Jest instrumentation), counters max-merged across runs — so the gutter, hover and totals work unchanged. Coverage rules (exclusions, counter merge) moved to `coverage/coverageRules.ts`, shared with Jest. The coverage source scan (`SourceCounter`) falls back to the shipped parser and a minimal walker (`utils/babel.ts`) — Vitest projects have no Babel, so untested files counted 0. The hover says "covering tests are not available for Vitest yet" instead of "trace data unavailable", and shows partial-branch detail without a trace. A full-suite coverage run (`runFullSuiteJson(root, true)`, unused by the extension) writes into the session dir, never the project's `coverage/`. e2e: fixture gets `@vitest/coverage-v8` and an untested source file; scenario `vitest-coverage`.

### Vitest support (phase 4 — live progress)

- **Reporter tests (task 4.3)** — `test/vitestReporterSource.test.ts` loads the generated reporter in a separate node process and drives it with synthetic Vitest task trees and hooks: the Vitest 3+ path (live events in order, json-shaped `file-end` result, failures before `file-end`, no duplicates from `onTestRunEnd` / `onFinished` / `onTaskUpdate`), the `onTaskUpdate` path of Vitest 1–2, a crashed file reported at run end with its hook failure, and Vitest 1's `<file>:<line>:<col>` console tags.
- **Live Vitest batches (task 4.2)** — `VitestBatchRunner` now runs `VitestRunner.liveCommand()` through `Executor.runWithReporterPolling` and applies the reporter's events as they arrive: a file shows running on `file-start` (not when the batch starts — Vitest runs a batch's files in parallel workers), each file's result (with its console output and failures, `applyVitestEvents`) is applied on its `file-end`, so results and progress stream per file. Hangs: one test running longer than `hangTimeoutSeconds` (from `test-start` / `test-end` heartbeats) stops the batch and fails that file, like Jest's batch runner; a worker stuck in a synchronous loop may never send its "test started" update (Vitest batches them), so a batch with no event for `hangTimeoutSeconds × 3` is stopped too and its unfinished files retried one by one. The reporter writes a file's failures before its `file-end` so a live reader has them when it applies the result. e2e: new `vitest-batch` (math.test.js has its result while slow.test.js still runs; per-file progress), `vitest-save-during-run` (one run-finished, progress ≤ 100 %, newest run wins, no process left); `vitest-hang` accepts either hang path.
- **Live reporter (task 4.1)** — the runner's Vitest reporter also streams progress: `file-start`, `test-start` / `test-end` heartbeats and `file-end` with the file's result in the json reporter's shape (built from the finished task tree, so `liveFileResult()` parses it with `parseVitestResult`). Vitest 3+ uses the new reporter API (`onTestModuleStart` / `End`, `onTestCaseReady` / `Result`), Vitest 1–2 `onTaskUpdate` (Vitest 2 has part of the new API but not those hooks, so the choice is by `ctx.version`); failures are written per file as it ends, and anything not reported (crashed files) at run end. `applyVitestEvents()` (console output + failures for a RunResult) is shared by plain runs and the batch runner; `VitestRunner.liveCommand(files)` builds a batch command with its events file. Checked on Vitest 1.6, 2.1 and 5.0: each file's result arrives when that file finishes. Fixed on the way: on Vitest 2 a describe suite (no parent link) was taken for a file.

### Vitest support (phase 3 — logs & output)

- **Failure details (task 3.2)** — the runner's Vitest reporter also records failures from the finished task tree (`onTestRunEnd` on Vitest 3+, `onFinished` before; 4+ dropped `onFinished`): for tests, suites and files, each error's name, message, diff and stack (parsed `stacks` on 4+). A failed test now shows `Name: message`, the expected / received diff (ANSI stripped) and `❯ src/a.test.ts:5:30` — the first frame in the project's own code, source-mapped, relative to the root; the json report had none of that. A failing `beforeAll` / `afterAll` shows its real error and location (`In "Hooked" (…): setup broke ❯ src/hook.test.js:6:11`) instead of the placeholder from 2.3, and the file is marked failed while its skipped tests stay skipped; a file that cannot load gets its location. Checked on Vitest 1.6, 3.2 and 5.0. `formatVitestError()`, `errorLocation()` in `framework/vitestReporter.ts`. e2e: fixture `src/hook.test.js` + 5 checks in `vitest-output`.
- **Console output per test (task 3.1)** — the json reporter drops console output, so the runner adds its own Vitest reporter (`framework/vitestReporter.ts`; written to the session dir and loaded with `--reporter=<file>` next to `default` and `json`, the JSON now goes to `--outputFile.json=`). It records each console call from `onUserConsoleLog` with the task that made it (the task chain is found in the file's tree — parent links are not filled in for suites on every version; Vitest 1 tags module-scope output `<file>:<line>:<col>`) into a JSON-lines file (`LTR_VITEST_EVENTS`). `VitestRunner.afterRun` attaches the lines to each file's `consoleOutput` with `scope` (`file` / `suite` / `test`) and `scopeName`. `RunnerBackedAdapter` gives every test that ran exactly its own output (empty for a quiet test), suites their hooks' output, the file all lines; Jest output (no scope) is handled as before. Vitest's default reporter output streams to the Test Output channel (`ExecutorCommand.forwardStdout`). Same attribution verified on Vitest 1.6, 2.1, 3.2, 4.1 and 5.0. New runner hooks `CommandRunner.runEnv()` / `afterRun()` / `forwardsStdout`. e2e: fixture `src/logs.test.js` + scenario `vitest-output`.

### Vitest support (phase 2)

- **Runner `VitestAdapter` (task 2.1)** — replaces the `ViteAdapter` stub; the framework id is now `vitest` (`FRAMEWORK_IDS.vite` → `FRAMEWORK_IDS.vitest`, `ADAPTER_PRIORITIES.vite` → `.vitest`). Detection: a `vitest` dependency or a `vitest.config.*` / `vitest.workspace.*` file, and nothing marking the project as Jest (BUG-37 rule kept). Binary: `vitest/package.json#bin` (`vitest.mjs`), resolved like Node would (local, hoisted, pnpm) and run with node — no `.bin` shim, no npx fallback; a missing install gives an actionable error. Config: `vitest.config.*` before `vite.config.*`, else Vitest decides. The installed version sets the capabilities (≥ 3 full; older: runs and results only). If Vitest's `engines.node` rules out the editor's built-in Node and no `node` is on PATH, the run stops with an explanation; a too-old PATH Node only logs a WARN. `outputFileArg` = `--outputFile=`; `createRunner` still throws `UnsupportedFrameworkError` until task 2.2.
- **`FrameworkAdapter.capabilities(projectRoot)`** — new `FrameworkCapabilities` (`results`, `nameFilter`, `listTests`, `related`, `liveStream`, `coverage`); Jest and CRA report everything. The conformance suite checks it.
- **`JestRunner` refuses non-Jest projects** — a Vitest project handed to the Jest runner gets a stand-in adapter that throws `UnsupportedFrameworkError` when a run starts (same moment and message as the old stub), so it can never launch `vitest` with Jest flags. `UnsupportedFrameworkError` moved to `framework/UnsupportedFrameworkError.ts`.
- **`VitestRunner` (task 2.2)** — `VitestAdapter.createRunner()` now returns a `VitestRunner extends CommandRunner`: `vitest run [abs files] … --reporter=json --includeTaskLocation --passWithNoTests --watch=false [-t pattern] --outputFile=<tmp>`, `vitest list --filesOnly --json` (deduplicated across projects; no list → folder scan), `vitest related <file> --run` (Vitest < 3: full run). `--reporter=json` always replaces config reporters; no `--root` (cwd is the project root, so a config's own `root` wins). Name patterns: Vitest 5 matches `-t` against `Outer > Inner > adds`, Vitest ≤ 4 against `Outer Inner adds`; `toVitestNamePattern()` makes each literal space `(?: > | )` so the extension's patterns work on both (verified on Vitest 4.1 and 5.0). `VitestAdapter.getExtraArgs()` / `resolveConfig()` read the `test` script (`testScriptVitestArgs`: `--config`, `--project`, `--root`, `--dir`, `--mode`, `--environment`, `--globals`, …), following `nr x` / `npm run x` / `pnpm x` / `yarn x` / `bun run x` with their extra args (vueuse: `--project=unit --project=server`). Vitest joins the adapter conformance suite. Checked on read-only clones: unplugin (Vitest 5) per-file results equal a plain `vitest run`.
- **Vitest result parsing (task 2.3)** — `parseVitestResult()` (`parsing/VitestResultParser.ts`) replaces the borrowed Jest parser for Vitest. Built from real reports of Vitest 1.6, 2.1, 3.2, 4.1 and 5.0 (kept as fixtures): Vitest 1's empty file-level ancestor is dropped (`['', 'Outer']` / `' Outer adds'`); counts come from the tests (Vitest 1 reported 8 passed for 4; pending = skipped, not todo, as in Jest); a file that cannot load or has no tests gets Vitest's `message` as its `failureMessage`; a failing `beforeAll` / `afterAll` (file failed, tests skipped, error not in the report) and an unhandled error (exit 1 while every test passed, nothing printed) get plain explanations instead of nothing / "Tests failed"; Vitest 1's assertion positions on failed tests are not used as test lines; durations are rounded; colour codes and stack lines are stripped. On a read-only unplugin clone, all 201 test statuses and the counts equal a plain `vitest run`.
- **Vitest projects and the browser-mode guard (task 2.8)** — a Vitest config with `test.projects` runs from the project root once (Vitest fans out). Browser-mode projects (Playwright / WebdriverIO) are left out by default: `framework/vitestProjects.ts` asks the project's own Vitest node API (`createVitest`, a small probe script run with node, ~0.5 s, cached per config / package.json mtime) for its projects and their `browser.enabled`; when some use browser mode and the test script picks no `--project` itself, `VitestRunner` names every other project with `--project=<name>` (a positive list — `!name` negation is newer than our Vitest baseline) and logs one INFO line saying which were left out. New setting `liveTestRunner.vitestIncludeBrowserProjects` (default false) runs them too; `RunnerOptions.includeBrowserProjects`; new `CommandRunner.prepare()` hook (async work before a command is built). Checked on a vueuse clone with a plain `vitest run` script: `browser (chromium)` and `browser (webkit)` left out, server / unit / exports run, results equal a plain `vitest run --project=server --project=unit --project=exports` (136 files, 942 passed, 63 failed — vueuse's exports test needs a build). The json reporter has no project name per file, so results do not carry it yet (phase 7 / the live reporter).
- **Session parity for Vitest (task 2.6)** — `FrameworkServices` gains `terms` (wording for log / status messages: config name and rules, list / related commands, batch and plain-run names, what a fallback loses) and `features` (`trace`, `timeline`; both false for Vitest). `SessionManager`'s messages use them — Jest projects keep the exact old text ("Jest config (testMatch / testPathIgnorePatterns)", "jest --listTests", "falling back to plain Jest …"); Vitest projects read "Vitest config (include / exclude)", "vitest list", "vitest related", "plain Vitest". Confirmed with Vitest in real VS Code: no runs before Start (session guard), a saved test file reruns alone, a saved source file runs `vitest related`, ▶ Run uses a `-t` pattern and leaves siblings alone, saves after Stop run nothing, Stop kills the Vitest CLI and its workers with no retries afterwards, an infinite loop stops its batch after `hangTimeoutSeconds × 3` and the per-file retry fails only the hanging file, a never-resolving promise fails on Vitest's timeout. New e2e scenarios `vitest-session`, `vitest-stop`, `vitest-hang`; harness `vitestProcesses()` (Vitest renames its processes to `node (vitest)` / `node (vitest N)`, so they are matched by title too).
- **Discovery: Vitest syntax (task 2.5)** — static discovery (`testDiscovery.js`) now reads Vitest's curried `.for([...])(…)`, `.skipIf(c)(…)`, `.runIf(c)(…)` (on tests and describes) like `.each`; `suite` imported from vitest as `describe`; renamed imports (`import { test as base } from 'vitest'`); fixtures made with `.extend(…)` (chained, TS generics, `as` / `satisfies`); and `test` / `it` imported from the project's own modules (relative paths, `@/` `~/` `#` aliases — Vitest fixture files) — before, those imports were treated like tstyche's and hidden. `bench` stays out. Fixes (any framework): the inner call of `describe.each([...])(name, fn)` closed the suite early, so its tests were discovered at the file's root until the first run rebuilt the tree; `.ts` / `.mts` / `.cts` files are parsed without the JSX plugin, so a generic arrow `<T>(x: T) => …` no longer makes the whole file unparseable (vueuse's useFetch test). New unit tests `test/testDiscovery.test.ts`; on the real repos every test file with static tests is found (unplugin 180, slidev 314, vueuse 1568 tests; only two generated-test files have none), and the Jest repos discover exactly what they did before.
- **Extension: Vitest projects run (task 2.4)** — the extension `JestAdapter`'s framework-neutral half (single-file / test-case / related runs, mapping `FileRunResult`s into the `ResultStore`) moved to `framework/RunnerBackedAdapter.ts`; `JestAdapter` keeps detection, its `JestRunner` and the debug config. New `framework/VitestAdapter.ts` (detection, `VitestRunner` with `liveTestRunner.vitestCommand`, debug launch of `vitest.mjs run <file> [-t …] --no-file-parallelism --test-timeout=0` with `autoAttachChildProcesses`), `session/VitestBatchRunner.ts` (one Vitest process per batch, results applied when it exits; whole-batch hang limit, then per-file retries), `session/VitestProjectConfig.ts`, `framework/vitestServices.ts`. `DetectingFrameworkProvider` replaces `SingleFrameworkProvider` in `extension.ts`: it detects the project's framework and builds the Jest or Vitest bundle on first use. `FrameworkServices.instrumentedRunner` is optional; the Timeline command reports "not available for Vitest yet". `runMode: npm` is ignored for Vitest (one WARN). New setting `liveTestRunner.vitestCommand`. Vitest / Vite config files are part of the runnable-files cache key only when present (Jest keys unchanged).
- **Discovery without the project's Babel** — static test discovery used the project's `@babel/parser` / `@babel/traverse` only; Vitest projects usually have none, so no tests were found. It now falls back to `@babel/parser` shipped in `out/vendor/` (copied by `esbuild.js`; the .vsix has no node_modules) and a built-in call-expression walker. `describe` / `it` / `test` imported from `vitest` count as test functions (they were treated like tstyche's).
- **A file that fails to load shows its reason** (any framework) — `RunnerBackedAdapter` fails the file's tests with `FileRunResult.failureMessage` when no test ran, and adds a file-level failure (e.g. a failing hook) to the file's output. Before, the tests stayed pending with no reason.
- **Framework feature matrix** — `docs/framework-features.md` is the single source; `node scripts/framework-matrix.js` copies it into the README and the HTML guide (`--check` reports drift).
- **Fix: Vitest found no tests on Windows when the project path has an 8.3 short name** (`C:\Users\RUNNER~1\…`, GitHub's Windows runners, `%TEMP%` for long user names) — file filters were sent as the real path (`runneradmin`), as Jest needs, but Vitest takes its root from the cwd exactly as given, so nothing matched and every run came back empty. New `CommandRunner.spawnPath()` hook (default: unchanged, so Jest is unaffected); `VitestRunner` and the project probe run Vitest from the real path with the real `--config` path, so root, config and filters agree. Unit test with a junction / symlinked root.
- **Fix: Vitest still ran no tests on Windows with an 8.3 project path** ("Vitest failed to find the current suite") — the CLI entry came from `require.resolve`, which keeps short names and the editor's lower-case drive (`c:\Users\RUNNER~1\…\vitest.mjs`), while root and test files used the real path, so Vitest loaded twice and tests registered with the wrong copy. New `toSpawnPath()` (native realpath, upper-case drive, falls back to `toRunnerPath`) spells the CLI entry, cwd, `--config`, file filters, the project probe and the ▷ Debug launch config the same way. `CommandRunner.spawnPath()` now applies to the binary too (identity for Jest). The live batch command (`VitestRunner.liveCommand`) spells its binary the same way.
- **e2e** — fixture `vitest-basic` (Vitest 3.2.4; config reporter `dot`, a TS file, a file that cannot load, a file outside `include`) and scenario `vitest-full-run` (framework chosen, `[vitest#N]` processes, `--reporter=json`, results = plain `vitest run`, nested suites / `.each` / todo / test lines, load error shown, excluded file not run, no fallbacks). Harness: `plainVitestJson`, `checkMatchesPlainVitest`.
- **Runner layer** — `CommandRunner` gains `leadingArgs(request)` (subcommand + positionals before the config; empty for Jest, so Jest command lines are unchanged — snapshots pass) and `processLabel` (output tag; `ExecutorCommand.label`, so Vitest lines read `[vitest#N]`). `refusingAdapter()` moved to `framework/refusingAdapter.ts` and is used by both runners. `requireAdapter()` / `requireProjectRoot()` are protected.
- **Fixes** — the Executor no longer adds `jest` after `npx` when the command already names a package (a `jestCommand` of `npx jest` ran `npx jest jest …`; `npx vitest` now works). The test-script tokenizer handles quotes inside a token (`--project="browser (chromium)"`, `--config="my config.js"`), for Jest and Vitest scripts.
- Runner helpers: `utils/semver.ts` (`parseVersion`, `compareVersions`, `satisfies` — enough for `engines.node` ranges, no dependency), `nodeRuntimeVersion()`, generic `resolvePackageBin(pkg, bin, fromDir)` / `resolvePackageDir()`.

### Tests

- **Vitest e2e and real repos (task 2.7)** — new scenarios `vitest-scoped-run` (test / suite / `test.each` template reruns with the right `-t` patterns, nothing else touched) and `vitest-debug` (▷ Debug builds a `vitest.mjs run <file> -t …` launch with `autoAttachChildProcesses`; the configs run exactly 1 test, a suite's 2, both `.each` rows); `repo-vitest` runs real Vitest projects through `real-repos.js` (unplugin, slidev, vueuse — compared test for test with a plain `vitest run` on the same clone, plus discovery before Start, ▶ Run, save-to-rerun, Stop). Vitest repos get a plain-Vitest baseline in `vitest-baseline.json`. Found with slidev: a test file whose tests are generated at runtime (no static `test(...)` calls) was dropped by discovery even though the framework runs it — files the framework lists (`vitest list` / `jest --listTests`) are now added to the tree without static tests, and their results fill them in (any framework).
- **Real-repository matrix** — `node e2e/real-repos.js [repo… | --all | --fresh]` copies each real Jest project (APFS copy-on-write on macOS), runs the repo scenarios on the copy, and fails if the original repository changed (HEAD, `git status`, newest mtime). Plain-Jest per-file counts and the match result are recorded in `docs/temp_plans/vitest-baseline.json`. Vitest repos are registered for when Vitest support lands.
- **Jest monorepo in the matrix** — `node e2e/real-repos.js jest` now works end to end: the plain-Jest reference runs used spawnSync's 1 MB default buffer, which killed Jest on big projects (exit null, no baseline); `repo-tsjest` picks the source file for the save test from `packages/*` when there is no top-level `src/`, and reports how many files differ. Found BUG-43 (jest-runtime tests fail under the session run — present in 2.0.4 too, open).

### CI

- Workflows use `pnpm/setup@v3` (pnpm from `packageManager`, Node 24, pnpm store cache and install in one step) instead of `pnpm/action-setup` + `actions/setup-node`. The release job keeps the install conditional (`install: false`).
- GitHub Actions on their current majors (all Node 24): `actions/checkout` v5 → v7, `actions/cache` v4 → v6, `actions/upload-artifact` v4 → v7, and in the Pages workflow `configure-pages` v5 → v6, `upload-pages-artifact` v3 → v5, `deploy-pages` v4 → v5 (+ `actions: read` permission; the `.nojekyll` marker is dropped — `upload-pages-artifact` ≥ 4 leaves dotfiles out, and an Actions-deployed site is not built with Jekyll anyway). No workflow uses `pull_request_target`, so checkout v7's fork-PR block does not apply.

---

## [2.0.4] - 2026-10-19

### Maintenance

- Added PR checks workflow (branch naming/target rules, tests, version-bump check on PRs to `main`).
- Replaced the tag-triggered publish workflow with `release.yml`: merging to `main` builds, tests, publishes, then tags `vX.Y.Z` and creates a GitHub Release.
- Introduced `release/*` branches; documented the branching workflow in `CLAUDE.md` and `docs/developer-guide.md`.

### Logging overhaul

- **Levelled log channel** — "Live Test Runner" is now a VS Code `LogOutputChannel` with real `error` / `warning` / `info` / `debug` / `trace` levels, timestamps and a user-selectable level (Output ⚙ → Set Log Level). Lines read `[Area] message`.
- **Raw Jest output split out** — Jest's own output moved to a separate channel, **Live Test Runner: Jest Output**. It is ANSI-stripped, line-buffered, and each line is tagged with its process (`[jest#12]`) so output from concurrent batches can be told apart. Each run starts with a `──── Run #N · label ────` separator.
- **One summary per run** — `Run #N <trigger> — files · passed · failed · skipped · time — failing: …` replaces scattered start/finish lines. Discovery logs one summary (files, tests, cache hits, parse failures) instead of a "Cache hit" line per file.
- **Noise removed** — about 20 `[Coverage]` INFO lines per batch, the per-file `[LTR-SESSION-TRANSFORM] …` and `[LTR-TRANSFORM] …` lines, the reporter's PASS/FAIL dump (duplicated Jest's output), the `console.log` on every coverage-decoration refresh, and the timeline `ltr-debug.log` written on every run (now only at Debug level).
- **Diagnostics that matter kept or added** — when an instrumented batch returns no results, the warning includes the tail of Jest's stderr. Test files that fail to execute are a WARN with the first error line. The fallback to plain Jest says which files and why. Spawn failures (`ENOENT`) suggest the fix. Coverage drops (missing manifests) are summarised in one line.
- **Runner/core logs now visible** — `@live-test-runner/runner` exposes `createLogger` / `setLogSink`. The extension installs a sink, so runner/core warnings (e.g. the `npx jest` fallback) appear in the log channel instead of only in DevTools. `core` reuses the runner logger.
- **Child-process log protocol** — instrumentation running inside Jest writes `[LTR:<level>] msg` to stderr. `Executor` routes those lines to the log at that level and removes them from captured stderr. `LTR_LOG_LEVEL` is passed to Jest so instrumentation skips debug/trace writes at the default level.
- **Slow vs. stuck diagnostics** — `liveReporter.js` now writes a `start` record when Jest begins a file. `SessionTraceRunner` runs a watchdog: when no file has finished for 60 s it logs a WARN naming the file currently executing and how long it has been on it (repeats every 2 min while stuck). When an on-save run cancels an in-flight batch that shares a file, an INFO line says which batch was cancelled and that its files will be retried.
- **Repeat collapsing and early buffering** — identical consecutive lines collapse into "previous message repeated N more times". Lines logged before the channel exists are buffered and flushed.
- **New commands** — `Live Test Runner: Show Logs`, and `Live Test Runner: Copy Diagnostic Report` (versions, project/Jest setup, settings, last 300 debug+ log lines from an in-memory ring buffer → clipboard + untitled Markdown doc). `Show Raw Output` is renamed `Show Jest Output`.

### Bug Fixes

- **Console logs missing from the Results panel** — Jest enables verbose mode on its own when a single test file runs (and when the config sets `verbose: true`). Verbose mode prints console calls directly and leaves `testResult.console` empty, so single-file reruns (e.g. saving a test file) showed no logs. Session runs now pass `--verbose=false`. Verified against Jest 29: 0 → 2 captured entries.
- **Garbled symbols in the Output panel** — `Executor` decoded each pipe chunk separately, so multi-byte characters (`✓ ✕ ● ›`) split across chunks became `�`. It now uses `setEncoding('utf8')`, emits only complete lines, and strips ANSI codes (the channel's `ansi` language id did not render them).

### Audit fixes (BUG-03 … BUG-35, see `docs/bugs-and-issues.md`)

- **Jest runs without a shell (BUG-03, BUG-08)** — on Windows Jest ran through its `.cmd` shim via `cmd.exe`: every run failed in project paths containing a space, `^` was stripped and `|` piped. Jest's JS entry point is now resolved (CRA: react-scripts' Jest) and run with `node` from PATH; arguments arrive verbatim. Stop kills the whole process tree. Combined name patterns are grouped (`^(?:a|b)$`; `^a|b$` meant "starts with a OR ends with b").
- **Run lifecycle (BUG-15, BUG-23, BUG-24)** — one `run-started`/`run-finished` across overlapping runs (a save during the full suite no longer "finishes" it), progress totals from the extension (`run-progress`), Stop is final (no retry/fallback after it). Files show ⟳ only when Jest starts them; every failure path clears spinners; Stop reverts them. A save no longer cancels the batch running the same file. New setting `liveTestRunner.hangTimeoutSeconds` (default 300): a single test running longer is stopped and its file failed with an explanation. Jest's `pending`/`todo` show as skipped; files the project's config never runs (`jest --listTests`) show as skipped and are not run.
- **Config loading (BUG-07, BUG-12, BUG-20)** — `ProjectJestConfig` reads the project config with `jest --showConfig` (CRA: `react-scripts test --showConfig`) once per session: `jest.config.ts/.mjs/.json`, function exports, presets, multi-project configs and `--config` / `--resetMocks` / `--env` in the test script now apply. babel-jest fallback resolved via Node lookup (pnpm). CRA transformer options kept.
- **Per-test trace (BUG-04, BUG-28, BUG-19)** — the trace context is opened from the setup file (test files are not instrumented), so smart on-save reruns and "covering tests" work; hooks in `setupTests.js` add to the test instead of erasing it; no `process.on('exit')` listener per file.
- **Lost results (BUG-25, BUG-26)** — stale-suite cleanup removed whole subtrees of finished tests when a discovered placeholder (e.g. `it.each` `case $case`) got no result: vscode-jest showed 165 of 2012 tests. Same-name tests no longer collapse into one node (a failure could be hidden). `nameToPattern` understands `$variable` placeholders.
- **Instrumentation errors no longer fail test files (BUG-31)** — an optional chain inside another chain's call arguments (`a?.b?.c().includes(x?.d())`) crashed the session transform ("Container is falsy") and every test file importing that module failed to run. That `?.` is skipped for branch counting; any instrumentation error falls back to the plain transpiled code.
- **Debug (BUG-05, BUG-06)** — ▷ Debug debugs only its test/suite; the launch config uses Jest's JS entry from the project root, CRA's config, `nameToPattern` and an upper-case drive letter.
- **Timeline (BUG-12)** — Windows-safe source pattern, `.each` names, no env leak into the extension host, resolved config, CRA's Jest; transformers loaded like Jest does (ts-jest projects recorded nothing).
- **Smaller fixes** — coverage race / O(N²) updates (BUG-09); pattern reruns keep file output (BUG-10); total test count and line maps (BUG-11); drive-letter case mapping (BUG-13); `.mjs`/`.cjs` test files and `testFilePatterns` (BUG-17); instrumentation uses the real `fs` when tests mock it (BUG-27); transform cache kept per project across sessions (BUG-29); saves outside the project ignored (BUG-30); per-file node index and no full-tree resend on view show (BUG-16); summary running count fixed.
- **Settings (BUG-18)** — removed unused `showOutputOnFailure`; declared `coverageExclude`.
- **Faster Start (BUG-32)** — the `jest --listTests` answer is kept per project (`RunnableFiles.ts`) and reused while no test file, `package.json` / `jest.config.*` or run setting changed; Start waited 20 s for it on copy-requisition.
- **New test files run on save (BUG-33)** — a test file created after Start is checked with Jest again instead of being ignored.
- **`--findRelatedTests` reruns (BUG-34)** — `ResultParser` reads the file path from Jest's `name` field (results were filed under an empty path); the coverage "stale" flag is cleared when any on-save rerun ends.
- **File durations (BUG-35)** — test files show their total time (Jest's start → end) in both test lists; `ResultParser` now prefers that over the sum of test times.

### macOS verification and fixes (BUG-36 … BUG-41)

- **Symlinked project roots (BUG-36)** — Jest resolves symlinks in `rootDir`, so on macOS (`/var` → `/private/var`) and in any project opened through a symlink every listed file looked unknown (all shown skipped), ▷ Debug found no tests and coverage/trace paths never matched. New `JestPaths` (runner) records each root's real path: paths sent to Jest use it, paths read back are mapped to the editor's spelling.
- **Windows 8.3 short paths (BUG-42)** — the same translation now covers Windows: a project opened by a short name (`C:\Users\RUNNER~1\…`, as on GitHub's Windows runners), a junction or a `subst` drive ran nothing ("No files found"). Roots are resolved with `realpathSync.native`, like Jest, and compared case- and slash-insensitively.
- **Jest + Vitest projects (BUG-37)** — a `vitest` dependency no longer wins over a Jest dependency or Jest config (e.g. `@testing-library/jest-dom` ran nothing). `jest.config.cts/.mts/.json` are recognised.
- **`__tests__` folders (BUG-38)** — the default `testFilePatterns` adds `**/__tests__/**/*.*` (Jest's default `testMatch`); on Start, files `jest --listTests` reports but discovery missed are added.
- **One file in several Jest projects (BUG-39)** — results of a file run by more than one project (e.g. `jsdom` + `node`) are merged (`mergeFileResults`): a test fails if it failed in any project. Before, the last report replaced the others and could hide a failure.
- **Coverage after the first Start (BUG-40)** — coverage manifests now live next to the persistent transform cache, named by file path and content; cached transforms wrote none into the new session folder, so coverage was dropped.
- **Tooling (BUG-41)** — removed the unused `runner` → `core` dependency (a cycle pnpm 10+ refuses); build-script approvals moved to `pnpm-workspace.yaml` (`allowBuilds`); pnpm pinned to 12.14.0 via `packageManager`, used by CI through `pnpm/action-setup`. e2e: the launcher finds VS Code ≥ 1.142's `Code` binary on macOS; plain-Jest comparisons keep path case and map symlinks; the real-project scenario handles multi-project configs and checks that no coverage is dropped.
- **Dependencies** — Jest 30, `@types/jest` 30, ESLint 10 with a flat config (`eslint.config.mjs`, `typescript-eslint` 8), TypeScript 6.0, esbuild 0.28, `@vscode/test-electron` 3. `@types/vscode` and the extension's `@types/node` 16 stay matched to the minimum VS Code (1.74). `tsc` over the extension passes again (the logger class returned by `activate()` is exported).
- **Smaller package** — `packages/vscode-extension/.vscodeignore` (from `develop` / `feat/eshan/timeline`, corrected: the webviews load their files from `src/webview`, so that folder is kept) leaves out TypeScript sources, unit tests, source maps, build files and README media (served from GitHub via `--baseContentUrl`): 91 → 34 files, about 150 KB. New e2e option `LTR_E2E_EXTENSION_DIR` runs the suite against an unpacked `.vsix`; it passes.
- **From `feat/eshan/timeline`** — inline durations sit at the end of the test's line, and a line past the end of a shortened file is skipped (it showed at the end of the file). A result without a location keeps the line discovery found, and generated `.each` tests fall back to their template's line, so "go to file" lands on the `test.each(...)` call.
- **Verified on macOS** — every e2e scenario; vscode-jest (49 files / 2012 tests), jest-dom (31 files, two Jest projects) and a CRA app (14 files / 143 tests) match plain Jest test for test.

### Tests

- **End-to-end suite** (`e2e/`): launches a real VS Code with the extension and drives real commands against fixture projects (in a path with spaces) and real repositories, including a test-for-test comparison with plain Jest. `node e2e/run.js --all`.
- **Unit tests** (`packages/*/test`, esbuild transformer) and a root ESLint config; `pnpm lint` added to PR checks (BUG-14).
- **E2E in CI** — a PR-check job runs the e2e suite on Windows, Linux and macOS with a downloaded VS Code. Fixtures encode what the real projects taught: `it.each` `$var` tables, duplicate names, `jest.mock('fs')`, `setupTests.js` hooks, `--resetMocks` in the test script, slow-loading files, nested `?.`, and a Create React App fixture. Every fixture's results are compared with plain Jest.

### Docs

- `docs/bugs-and-issues.md` — full audit: 22 issues with symptom, root cause, fix and verification steps.
- `docs/live-test-runner-guide.html` — navigable user & contributor guide.
- Developer guide: new **Logging** section (levels, scopes, correlation tags, child-process protocol).

---

## [2.0.3] - 2026-05-15

### Bug Fixes

- Fixed issues with running tests with optional chaining. Ex: ?.()

---

## [2.0.2] - 2026-05-01

### Bug Fixes

- **Code Coverage Works on Windows** - Fixed path issues with Forward Backward slashes and capital simple dive letters. Also, Fixed the node path finder to work on both windows and macOS

---

## [2.0.1] — 2026-04-23

### Bug Fixes

- **CRA: tests staying "pending" after run** — `liveReporter.js` only implemented `onTestFileResult` (Jest 27+). In Jest 26 (react-scripts 4 / CRA 4), the reporter method is `onTestResult`. When neither fired, every file landed in the "missing" bucket: files were marked failed at the file level but individual test nodes were never updated, leaving them all as pending. Fixed by implementing both methods with deduplication (Jest 27 calls both; the set guard prevents double-reporting).
- **Noisy raw output** — `sessionTraceTransform.js` was writing a `process.stderr.write` debug line for every file it transformed, flooding the raw output channel. These lines are now removed (resolve/require errors are still logged).

---

## [2.0.0] — 2026-04-21

### Code Coverage

#### What's new

- **Live coverage badge** — the Explorer sidebar now shows a four-metric coverage badge (`Stmts X% | Branch X% | Fns X% | Lines X%`) that updates automatically after each test run. Hidden when no session is active; shows a scanning progress indicator while the initial source scan runs.
- **Coverage line decorations** — source lines are marked with a coloured `▌` bar: green (covered), amber (partial branch coverage), red (not covered), grey (non-executable). The overview ruler mirrors the same states so you can navigate uncovered regions from the scrollbar.
- **Coverage hover** — hovering any decorated source line shows: which tests cover it (with pass/fail status and duration), and for partially-covered branches, which arms hit or missed (`then`/`else`, `truthy`/`falsy`, `&&`/`||` leaves, `?.` null vs non-null, etc.). Each test name is a clickable link that reveals the test in the results panel; a file icon opens the test file directly.
- **Stale coverage overlay** — when you save a source file and a rerun is pending, the entire file gets a grey background tint until the rerun completes and fresh coverage data arrives.
- **Coverage Explorer tab** — the Explorer sidebar gains a second tab ("Coverage") showing project-level totals (Stmts / Branch / Fns / Lines) and a scrollable per-file breakdown. Click any file row to open it in the editor.
- **Correct coverage denominators** — source files that no test ever imports are scanned in the background at session start (`SourceCounter`) and included as 0% in the aggregate totals. This matches Istanbul's `all: true` behaviour — no more inflated percentages.
- **No performance impact** — coverage instrumentation shares the existing Jest transform pass (no second AST walk, no extra process). The background source scan yields to the event loop every 10 files to keep the UI responsive.

#### Technical details

- `sessionTraceTransform.js` now injects `__cov` statement/branch/function counters alongside the existing `__strace.step()` calls, and writes a per-file coverage manifest (JSON) to `<tmp>/coverage/manifests/`.
- `sessionTraceRuntime.js` flushes `globalThis.__cov` as a JSONL line to `COVERAGE_OUTPUT_FILE` on `process.exit`.
- `SessionTraceRunner._parseCoverage()` reads the JSONL, merges multi-worker counters, reads manifests, and promotes `CoverageStore` entries.
- Cross-run counter merging uses `max()` — re-running a subset of tests never reduces previously measured coverage.
- `CoverageDecorationManager` applies the `▌` bar via VS Code's `before` pseudo-element decoration (`contentText: '▌'`) so breakpoint gutters are never blocked. Five decoration types: covered, partial, uncovered, neutral, stale.
- `CoverageHoverProvider` is a `vscode.HoverProvider` registered for all JS/TS files. It reads the manifest and counters from the `CoverageStore` entry for the hovered file and line, then cross-references `ExecutionTraceStore.getTestsForLine()` + `ResultStore.findNodeByFullName()` for live status and duration.
- Two new commands wired for hover links: `liveTestRunner.revealTestInPanel` (reveals the test row in the Results panel) and `liveTestRunner.openTestFile` (opens the test file at the relevant test).
- **Bug fix (ts-jest):** `sessionTraceTransform.js` no longer injects `__covF.f["f0"]++` inside `jest.mock()` factory arrow functions. Babel's `jest-hoist` plugin hoists `jest.mock()` to the top of the file — before the `__covF` preamble — so any counter access inside the factory caused a `ReferenceError`. The fix detects this pattern and skips counter injection for mock factory functions.
- **Bug fix (stale after on-save rerun):** scoped reruns (individual test cases via `--testNamePattern`) do not produce a new coverage counters file, so `_parseCoverage` was never called and the `measured-stale` state was never cleared. Fixed by calling `CoverageStore.clearStale(sourceFilePath)` after `_runTestCases` completes in `_runAffectedBySourceFile`.
- **"Show all covering tests" Quick Pick** — when a line is covered by more than 5 tests, the hover now shows a "Show all N" link that opens a VS Code Quick Pick listing every covering test with pass/fail icon and file name. Selecting a test reveals it in the Results panel. New command: `liveTestRunner.showCoveringTests`.

---

## [1.4.0] — 2026-04-19

### Persistent Discovery Cache, Batch Execution & UI Performance

#### Added
- **Persistent discovery cache** — Babel AST parse results are now cached per file alongside mtime in `~/.../globalStorage/EshLabs.live-test-runner/cache/<project>/discovery-cache.json`. On restart, only files whose mtime has changed are re-parsed; everything else loads from cache. Large projects (800+ files) drop from ~30–60 s cold parse to a few seconds on warm restart.
- **Project-keyed cache directories** — each project gets its own cache dir keyed by `<folderName>-<sha256(workspacePath)[0:8]>`. Different projects with the same folder name never collide.
- **Session lock files** — a `session.lock` file containing the current VS Code PID is written on activation and deleted on deactivate. Cache rotation uses PID liveness checks to skip active sessions.
- **LRU cache rotation** — at Start Testing time, inactive project caches are evicted oldest-first when total cache size exceeds 500 MB or more than 10 projects are cached. Single-project installs are never capped.
- **Over-cap warning** — if all cached projects are active and the total still exceeds limits, a modal offers "Continue Without Cache" (runs exactly as before, no data lost) or "Cancel".
- **Shift+Stop to clear cache** — Shift-clicking the Stop button in either the sidebar or panel sends `stopAndClearCache`: stops the session and wipes this project's disk cache. In-memory state (test tree, results) is unaffected.
- **"Clear Cache and Restart Testing" command** — palette command that wipes the current project's cache and immediately restarts discovery + testing from scratch.
- **"Stop Testing and Clear Cache" command** — palette equivalent of Shift+Stop.

#### Changed
- **Discovery batch size adapts to cache warmth** — cold pass (no cache): 5 files per batch (unchanged, keeps UI progressive). Warm pass (cache present): 25 files per batch, reducing event-loop round-trips ~5× for large projects.
- **`onFileResult` messages batched** — file result postMessages are now collected in a 50 ms window and flushed as a single `batch-file-results` message instead of one message per file. Eliminates the webview freeze that occurred when dozens of files completed simultaneously.
- **`files-rerunning` renders once** — marking N files as running now updates all in memory and renders the test list once, rather than once per file (was O(N) full re-renders).
- **Discovery appends to DOM incrementally** — during discovery, new file rows are appended to the list using a `DocumentFragment` per batch instead of triggering a full list re-render per file. Fixes the slowdown / freeze that appeared as the list approached 200–800 files.
- **Row selection uses targeted DOM update** — clicking a test row now swaps the `selected` CSS class in-place instead of re-rendering the entire list. Full re-render only happens when ancestor nodes need to be structurally expanded.
- **Collapse toggle no longer triggers selection** — clicking the ▶ arrow to collapse/expand a row no longer fires a `select` message, which previously caused `scope-changed` → `_expandAncestors` to immediately re-expand the collapsed item.
- **Cross-panel selection restored on visibility** — `_sendInit` now includes the current selection. When either panel becomes visible after being hidden, it scrolls to the previously selected row.

#### Internal
- `src/cache/DiscoveryCache.ts` — new file: `DiscoveryCache` class + `rotateAndCheckCapacity` function
- `TestDiscoveryService` — accepts optional `DiscoveryCache`; cache-first in `_populateFile`; `BATCH_SIZE_COLD = 5`, `BATCH_SIZE_WARM = 25`
- `BaseWebviewProvider` — `onFileResult` now buffers into `_pendingFileResults`; flushes via `_flushFileResults()` after 50 ms
- `testListLayout.js` — `appendFiles()` for O(1) per-batch DOM appends during discovery; `markFilesRunning()` for single-render batch running state; `setSelected()` targeted class swap
- `Executor.runWithReporterPolling` — new method that polls a reporter JSONL file while a Jest child process runs, calling a callback for each parsed record.
- `IFrameworkAdapter.applyFileResult` — new interface method; `JestAdapter` exposes the existing `_applyFileResult` logic publicly so `SessionTraceRunner` can apply liveReporter records into the store without bypassing the adapter.
- `SessionTraceRunner.runFiles` replaces the old `runFile` (per-file trace) method entirely.

---

## [1.3.0] — 2026-04-14

### Dynamic Test Groups & Multi-Session Isolation

#### Added
- **Persistent dynamic anchors** — parameterized tests (`test.each`, loops) are now elevated to permanent "template" nodes in the sidebar. They remain visible as structural anchors even if they temporarily have zero children.
- **Lazy variation attachment** — dynamic test variations are attached as children to their parent templates in real-time as Jest emits results.
- **Multi-session isolation** — each VSCode window now uses a unique `session-<pid>-<timestamp>` temporary directory. This prevents concurrent windows from deleting or overwriting each other's temporary Jest configs and trace files.
- **Safe stale-data cleanup** — the extension now performs a PID-check on startup (`process.kill(pid, 0)`) to safely prune temporary session folders from previous crashes while leaving active sessions untouched.
- **Command pivoting** — clicking a dynamic variation in the sidebar now correctly reruns the parent template, ensuring that the full parameterized suite is executed.

#### Changed
- **Recursive status bubbling** — finalized the "nested branch compatibility." Status changes (pass/fail/running) deep in the tree correctly bubble up through all ancestors, including complex nested `describe` blocks and dynamic groups.
- **Real-time gutter synchronization** — gutter icons now flip to spinners the moment a test starts (even in scoped reruns) and update to their final result state without delay.
- **Unified LineMap management** — moved mapping responsibility into `ResultStore`, eliminating desync bugs where icons wouldn't update after partial test runs.

#### Internal
- `LTR_TMP_DIR` renamed to `LTR_BASE_TMP_DIR`; all internal components now use an injected `_tmpDir` or `_sessionDir` path for isolation.
- `ResultStore.cleanupStaleNodes` now explicitly ignores `template` nodes to preserve the structural anchors.

---

## [1.2.0] — 2026-04-14

### Recursive Nested Node Tree

#### Changed
- **Unlimited `describe` nesting** — the test tree now supports deeply nested `describe` blocks (5+, 10+, or more levels). The old rigid File → Suite → Test hierarchy has been replaced with a recursive `File → Node[]` tree. Every suite and test is a `TestNode` in a flat pool with `parentId`/`children` references.
- **Stable node IDs** — node IDs use the convention `{filePath}::{suite1}::…::{name}`. Static discovery and Jest results match automatically without a lookup table. Dynamic tests (`.each`, template literals, loops) use placeholder nodes cleaned up once Jest emits real results.
- **Live status rollup** — `bubbleUpStatus()` propagates worst-case status from any leaf up through all ancestors in O(depth). If one test fails deep in the tree, every parent suite and the file itself show a failure icon in real time.
- **O(1) summary counter** — `getSummary()` uses an incremental running counter instead of scanning all nodes. Safe for 10,000+ tests.
- **Scoped output at any level** — clicking any node in the tree (file, suite at any depth, or individual test) scopes the Output and Errors columns to that subtree. Output is never back-filled from parent scopes.
- **Webview renders recursively** — `testListLayout.js` uses `_renderNode()` for unlimited nesting depth with lazy child rendering (collapsed nodes don't generate DOM).
- **`SelectionState`**, **`IResultObserver`**, and **`IFrameworkAdapter`** interfaces all use `nodeId` instead of `suiteId`/`testId`.
- **`LineMap`** entries are now `{ nodeId, fileId }` instead of `{ suiteId, testId, fileId }`.
- **`testDiscovery.js`** returns a nested suite tree with `children[]` arrays instead of a flat map.
- **`TestDiscoveryService`** recursively walks the discovery tree using `_populateSuiteTree()`.
- **`JestAdapter._applyFileResult()`** builds node hierarchy from `ancestorTitles` and calls `bubbleUpStatus()` after each test result.

#### Internal
- `ResultStore` rewritten: flat `Map<string, TestNode>` pool, `rootNodeIds` per file, `makeNodeId()` helper, `serialiseFile()` for recursive JSON output.
- `DecorationManager`, `CodeLensProvider`, `BaseWebviewProvider`, `ExplorerView`, `ResultsView`, `SessionManager`, and `extension.ts` all updated to use `nodeId` throughout.

---

## [1.1.1] - 2026-04-13
- Fixed tests not running on large projects
- Fiixed tests not running on windows machines

---

## [1.1.0] — 2026-04-12

### Static Test Discovery, Smart On-Save Reruns & Execution Trace Store

#### Added
- **Run individual tests by name pattern** — `▶ Run` on a specific `it`/`test` line now passes `--testNamePattern` to Jest so only that single test case executes, rather than the whole file.
- **Parallel execution scaled to CPU count** — the concurrent file runner now defaults the worker pool size to the number of logical CPUs, replacing the previous hard-coded limit of 3.
- **Loading pane while collecting traces** — the Session panel shows a loading indicator while instrumented trace data is being collected, so there is no blank state between triggering a run and results appearing.
- **Trace tracker in the Explorer sidebar** — the Explorer now surfaces trace collection progress inline alongside the test tree so users can see which files have been traced without switching panels.
- **Static test discovery on project load** — the extension now parses every test file's AST immediately on activate (before the user clicks Start Testing). The full file → suite → test tree appears in the sidebar as files are scanned, with accurate line numbers and pending status icons.
- **`testDiscovery.js`** — lightweight AST walker (reuses project's `@babel/parser` + `@babel/traverse`). Extracts `describe`, `it`, `test`, `*.only`, `*.skip`, `*.each`, and `*.concurrent.*` calls. Template literals with interpolations are shown as readable patterns (`"accepts valid severity …"`). No code is executed or injected.
- **`TestDiscoveryService`** — orchestrates discovery on activate and file watching during idle periods. Parses files in batches of 8 with event-loop yields between batches so the extension host stays responsive on large projects (500+ files).
- **Incremental UI updates** — each parsed file is pushed to the webview immediately via `discovery-progress`, so the test list builds up progressively rather than appearing all at once after a full scan.
- **FileSystemWatcher** — monitors `**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}`. New files appear in the tree immediately on create. Existing files are re-discovered on save as long as no run is in progress (status `running` is the only guard — files with prior results are also re-discovered so newly added tests appear straight away).
- **Pending gutter icons** — `○` pending icons appear next to every discovered test line as soon as discovery finishes, before any test is run.
- **`▶ Run` / `▷ Debug` CodeLens on project load** — CodeLensProvider is now registered on extension activate instead of on session start, so run and debug buttons appear above `it`/`test` lines as soon as a file is open.
- **`◈ Results` CodeLens** — unchanged behaviour: only shown after a test has been run and a LineMap entry exists.
- **Discovering… button state** — Start Testing is disabled and shows `⟳ Discovering… N / total` while the initial scan is in progress. Re-enabled when discovery completes.
- **Race-condition safe init** — `_sendInit()` now carries `isDiscovering`, `discoveryTotal`, and `discoveryDone` fields so webviews that load mid-discovery restore the correct button state and progress counter without depending on message delivery order.
- **Test total counter during discovery** — the summary Total count ticks up as each file is parsed.
- **Three new `ResultStore` methods**: `fileDiscovered`, `suiteDiscovered`, `testDiscovered` — create `pending` entries; all no-op if the entry already exists so live results are never overwritten.
- **`ResultStore.removeFile`** — removes a single file entry and its line map; used by the watcher to force a fresh re-discovery of modified files.
- **`ResultStore.fileStarted` preserves structure** — when a file was pre-populated by discovery, `fileStarted` now preserves the suite/test tree and marks everything `running` instead of recreating with empty suites, so the tree stays visible during a run.
- **`IResultObserver` discovery events** (`onDiscoveryStarted`, `onDiscoveryProgress`, `onDiscoveryComplete`) — optional methods; `BaseWebviewProvider`, `DecorationManager`, and `CodeLensProvider` all implement them.
- **`DecorationManager` no longer disposes on session stop** — decoration types are kept alive between sessions so pending icons from discovery persist; `clearAll()` is called instead of `dispose()`.
- **Test-level smart reruns on source file save** — when a source file is saved, Live Test Runner now reruns only the specific test cases that actually executed code from that file (not the whole test file). After the first full run, the extension knows exactly which tests touched which source files via the execution trace. Tests in suites without shared state are rerun individually with a single combined `--testNamePattern`; suites with shared state rerun the whole file to keep results correct.
- **`ExecutionTraceStore`** — three in-memory indexes derived from per-test JSONL trace files and rebuilt after each instrumented run:
  - `traceIndex` — maps each test's full name to its `.jsonl` trace file path
  - `coverageIndex` — accumulates every source line executed by any test in the session (foundation for coverage overlay)
  - `sourceToTests` — maps each source file to the test files, suites, and individual test cases that covered it; drives smart on-save reruns
- **`SessionTraceRunner._partitionAndStore`** now populates `sourceToTests` — after each instrumented file run, all source files referenced in trace steps are mapped back to their covering suites and test cases.
- **`SessionManager._runAffectedBySourceFile`** — new method that consults `ExecutionTraceStore` first, falls back to `CoverageMap` / `jest --findRelatedTests` if no trace data is available yet (e.g. before the first full run completes).

#### Changed
- `SessionManager.start()` no longer runs its own file discovery. It awaits `TestDiscoveryService.awaitDiscovery()` (no-op if already done) then reads file paths directly from the store.
- `CodeLensProvider` is registered in `extension.ts` on activate rather than in `SessionManager.start()`.
- `testListView.js` and `resultsView.js` both handle `discovery-progress` to update the test list incrementally.
- `testListView.js` `applySessionState` now supports a `'discovering'` state that disables Start Testing and shows a file progress counter.
- `SessionManager.onSave` source-file branch now routes through `_runAffectedBySourceFile` instead of calling `_adapter.getAffectedTests` directly.
- On-save now runs individual test cases (one Jest invocation per affected file with combined pattern) instead of always rerunning whole test files when trace data is available.

#### Internal
- Trace files remain the ground truth. `ExecutionTraceStore` entries are derived caches — always rebuilt from trace files, never written independently. Clear both together on session reset.

---

## [1.0.0] — 2026-04-09

### Test List Improvements

#### Features
- **Search filters to test case level** — typing in the search bar now narrows results down to
  individual test cases. Only matching suites and tests are shown within each file; if a suite name
  matches the query all of its tests are shown, otherwise only the matching tests appear
- **State preserved across tab switches** — the Start / Stop buttons, live blinking indicator, and
  watch state are now correctly restored when returning to the explorer after switching VS Code tabs.
  Search query, failures-only filter, and folder-view toggle also survive the tab switch
- **Gutter status icons** — pass ✓ / fail ✗ / running ⟳ / pending ○ icons appear next to each
  `it()` and `test()` line as soon as results arrive; cleared automatically when the session stops
- **Inline duration text** — muted duration label rendered after the closing paren of each test
  block, colour-coded green (< 100 ms) / amber (100–500 ms) / red (> 500 ms)
- **CodeLens run button** — `▶ Run` appears above each `describe`, `it`, and `test` block while a
  session is active; clicking reruns that test (or the whole file if no result exists yet)
- **CodeLens debug button** — `▷ Debug` above each block launches Jest in debug mode via
  `vscode.debug.startDebugging` with `--runInBand --no-coverage`, scoped to that test via
  `--testNamePattern`
- **Jump to results** — `◈ Results` CodeLens on `it`/`test` lines with known results; clicking
  focuses the Test Results panel and scrolls to and selects the matching row
- **Session-scoped** — CodeLens entries and gutter decorations are only visible while a session is
  active; stopping clears everything immediately

---

## [0.2.0] — 2026-04-04

### Editor Inline Decorations

#### Features
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

#### Internal
- `JestTestCaseResult` now carries an optional `location: { line, column }` field populated from
  Jest's `--json` output
- New `LineEntry` type and `LineMap` methods added to `ResultStore`
- New `EditorDecorationManager` class owns all `TextEditorDecorationType` instances
- New `LiveTestCodeLensProvider` class provides CodeLens via regex line scan (no AST)
- SVG gutter icons in `resources/icons/` (passed / failed / running / pending)

---

## [0.1.0] — 2026-04-03

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
  parameter is supplied.

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

### Future
- Coverage overlay (% per file in tree)
- Re-run a single file or single test from the custom tree
- Persistent results across window reloads
- Monorepo multi-root support
