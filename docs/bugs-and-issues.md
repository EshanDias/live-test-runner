# Bugs & Issues — Analysis

> Audit of the whole app (runner · core · extension · instrumentation), done on branch `feat/logging-overhaul` (2026-10-19).
> Fixed on `bugfix/audit-fixes` (2026-10-20). Each entry: **cause → fix → how it was verified**.
> All entries verified on Windows and macOS (2026-10-20: every e2e scenario, plus vscode-jest, jest-dom and a CRA app on macOS).

**Severity:** 🔴 High (wrong results / feature broken) · 🟠 Medium (flaky or misleading) · 🟡 Low (cleanup / polish)
**Status:** ✅ fixed and verified (e2e) · 🔲 open

**How things were verified.** `e2e/` launches a real VS Code with the extension and drives real commands against real Jest processes:
- fixture projects, copied to a temp folder whose path contains spaces: `basic` (plain Jest 29, `verbose: true`), `ts-config` (`jest.config.ts` + ts-jest), `esm-fn-config` (async `jest.config.mjs`);
- **vscode-jest** (ts-jest, `automock`, 49 files / 2012 tests) — every file's pass/fail/skip counts compared with a plain `jest --json` run;
- **copy-requisition** (Create React App, react-scripts 5 / Jest 27, 197 files) — sample files compared with plain `react-scripts test`, plus a full run: 1789 tests, 1769 passed / 7 failed / 13 skipped — the same totals as plain Jest (two timing-sensitive UI tests swapped pass/fail between the runs). 25.7 min with a warm transform cache vs 32 min plain Jest; no fallback, no hang stop, nothing left spinning.

Run them with `node e2e/run.js --all` (see [developer-guide.md](developer-guide.md#end-to-end-tests)). Scenario names are given below as `scenario`.

---

## Index

| ID | Sev | Status | Title |
|----|-----|--------|-------|
| [BUG-01](#bug-01) | 🔴 | ✅ | Console logs sometimes don't appear in the Results panel |
| [BUG-02](#bug-02) | 🔴 | ✅ | Output channel shows symbols / garbage instead of letters |
| [BUG-03](#bug-03) | 🔴 | ✅ | Windows: `cmd.exe` mangled patterns — and broke every run in paths with spaces |
| [BUG-04](#bug-04) | 🔴 | ✅ | Per-test trace was never recorded → smart reruns and "covering tests" never worked |
| [BUG-05](#bug-05) | 🔴 | ✅ | CodeLens **▷ Debug** always debugged the whole file |
| [BUG-06](#bug-06) | 🔴 | ✅ | Debug launch config broken on Windows, in sub-folder roots and for CRA |
| [BUG-07](#bug-07) | 🔴 | ✅ | `jest.config.ts` / `.mjs` / function configs ignored by the instrumented runner |
| [BUG-08](#bug-08) | 🟠 | ✅ | Stop did not kill Jest; results kept arriving after Stop |
| [BUG-09](#bug-09) | 🟠 | ✅ | Coverage randomly 0% for tested files; O(N²) coverage messages |
| [BUG-10](#bug-10) | 🟠 | ✅ | Scoped reruns overwrote the file's console output |
| [BUG-11](#bug-11) | 🟠 | ✅ | Test count drifted up after files were deleted |
| [BUG-12](#bug-12) | 🟠 | ✅ | Timeline recorded 0 steps on Windows, for `.each` tests and TypeScript |
| [BUG-13](#bug-13) | 🟠 | ✅ | Windows drive-letter case mismatch |
| [BUG-14](#bug-14) | 🟠 | ✅ | `pnpm test` / `pnpm lint` could never pass |
| [BUG-15](#bug-15) | 🔴 | ✅ | "Finished" shown while tests were still running |
| [BUG-16](#bug-16) | 🟡 | ✅ | Large-project performance |
| [BUG-17](#bug-17) | 🟡 | ✅ | `.mjs` / `.cjs` test files treated as source files; `testFilePatterns` ignored |
| [BUG-18](#bug-18) | 🟡 | ✅ | Dead / undocumented settings and doc mismatches |
| [BUG-19](#bug-19) | 🟡 | ✅ | `process.on('exit')` listener added once per test file |
| [BUG-20](#bug-20) | 🟡 | ✅ | CRA transformer options dropped |
| [BUG-21](#bug-21) | 🟡 | ✅ | Debug leftovers |
| [BUG-22](#bug-22) | 🟡 | ✅ | Logs were noisy, single-level and partly invisible |
| [BUG-23](#bug-23) | 🔴 | ✅ | Tests spun ("running") forever |
| [BUG-24](#bug-24) | 🟠 | ✅ | Some tests never started (stayed ○ pending) |
| [BUG-25](#bug-25) | 🔴 | ✅ | **New:** whole files of results vanished (stale-suite cleanup) |
| [BUG-26](#bug-26) | 🟠 | ✅ | **New:** tests with the same name collapsed — a failure could be hidden |
| [BUG-27](#bug-27) | 🟠 | ✅ | **New:** instrumentation broke when tests `jest.mock('fs')` |
| [BUG-28](#bug-28) | 🟠 | ✅ | **New:** hooks in `setupTests.js` erased the per-test trace |
| [BUG-29](#bug-29) | 🟠 | ✅ | **New:** every session re-transformed the whole project |
| [BUG-30](#bug-30) | 🟡 | ✅ | **New:** saving files outside the project triggered runs |
| [BUG-31](#bug-31) | 🔴 | ✅ | **New:** an instrumentation crash failed every test file importing that source |
| [BUG-32](#bug-32) | 🟠 | ✅ | **New:** Start waited for `jest --listTests` every time |
| [BUG-33](#bug-33) | 🟠 | ✅ | **New:** a test file created after Start was ignored on save |
| [BUG-34](#bug-34) | 🟠 | ✅ | **New:** `--findRelatedTests` results went nowhere; coverage stayed "stale" |
| [BUG-35](#bug-35) | 🟡 | ✅ | **New:** no time shown on test files |
| [BUG-36](#bug-36) | 🔴 | ✅ | **New (macOS):** projects opened through a symlink — every file "skipped", Debug ran nothing |
| [BUG-37](#bug-37) | 🔴 | ✅ | **New:** projects with both Jest and Vitest were treated as Vitest (nothing ran) |
| [BUG-38](#bug-38) | 🟠 | ✅ | **New:** tests in `__tests__/` folders (no `.test.` in the name) were not found |
| [BUG-39](#bug-39) | 🔴 | ✅ | **New:** a file run by several Jest projects kept only the last project's result |
| [BUG-40](#bug-40) | 🔴 | ✅ | **New:** coverage dropped on every Start after the first (cached transforms) |
| [BUG-42](#bug-42) | 🔴 | ✅ | **New (Windows):** 8.3 short paths (`RUNNER~1`) — nothing ran on GitHub's Windows runners |
| [BUG-43](#bug-43) | 🔴 | 🔲 | jest-runtime tests fail under the session run (jest monorepo) |
| [BUG-41](#bug-41) | 🟠 | ✅ | **New:** tooling — pnpm 10+ could not install or test; e2e could not start VS Code ≥ 1.142 on macOS |

---

<a id="bug-01"></a>
### BUG-01 🔴 ✅ Console logs sometimes missing
Jest switches to verbose mode for single-file runs (and with `verbose: true`), which empties `testResult.console`. Session runs pass `--verbose=false`. **Verified:** `basic-full-run` (fixture has `verbose: true`), `basic-scoped-run`.

<a id="bug-02"></a>
### BUG-02 🔴 ✅ Garbled output
Chunk-split UTF-8, ANSI codes, interleaved half-lines. `Executor` uses `setEncoding('utf8')`, a line splitter and `stripAnsi`; each line is tagged `[jest#N]`. **Verified:** fixtures log `✓ ünïcödé`; unit test for `stripAnsi`.

<a id="bug-03"></a>
### BUG-03 🔴 ✅ `cmd.exe` mangled arguments
Jest ran through its `.cmd` shim with `shell: true`. Worse than first thought: in a project path **containing a space**, *every* run failed (`'C:\…\ltr' is not recognized…`) and all tests spun forever. Also `^` was stripped and `|` piped.
**Fix:** `BinaryResolver` resolves Jest's JS entry point (through `jest/package.json`, since Jest's `exports` hides `bin/jest.js`; CRA → react-scripts' Jest) and `Executor` runs it with `node` from PATH (fallback: the editor's runtime with `ELECTRON_RUN_AS_NODE`), **no shell**. A shell is used only for a user `jestCommand` / npx, with every argument quoted. Also: combined patterns were `^a|b$` ("starts with a OR ends with b") — now `^(?:a|b)$`; suites match `^(?:name)(?: |$)`.
**Verified:** `basic-scoped-run` (`a^b | c & d`, same leaf name in two suites, suite rerun — exactly the right tests run), runner unit test (args verbatim from a folder with spaces).

<a id="bug-04"></a>
### BUG-04 🔴 ✅ No per-test trace
Test files are not instrumented, so `enterTest()` never ran. `ltrCoverageSetup.js` now drives test boundaries (`beginFile` / `beginTest` / `endTest`). Module-load hits feed coverage only (otherwise every save would rerun whole files). Trace paths are mapped to store keys.
**Verified:** `basic-full-run` (source → tests, covering tests per line), `basic-on-save` (saving `strings.js` reruns only the 2 tests in `mixed.test.js` that call it; `math.test.js` untouched), `repo-tsjest`, `repo-cra`.

<a id="bug-05"></a>
### BUG-05 🔴 ✅ ▷ Debug debugged the whole file
The CodeLens passed the test name where the handler expected a line. It now passes the line; suites debug all their tests. **Verified:** `basic-debug` (test, suite, `test.each` — each replayed with plain node: exactly 1 / 4 / 2 tests run).

<a id="bug-06"></a>
### BUG-06 🔴 ✅ Debug launch config
`program` is Jest's JS entry resolved from `projectRoot` (CRA: react-scripts' Jest + `--config <extracted>`), `cwd: projectRoot`, `nameToPattern`, test-script flags, and an upper-case drive letter in `--runTestsByPath` (Jest realpaths `rootDir`, so `c:/…` matched nothing). **Verified:** `basic-debug`, `repo-tsjest`, `repo-cra` (CRA debug config runs exactly 1 test).

<a id="bug-07"></a>
### BUG-07 🔴 ✅ Other config formats ignored
New `ProjectJestConfig`: `jest --showConfig` (CRA: `react-scripts test --showConfig`) once per session; the generated configs build on that (multi-project included). Global options kept: `globalSetup`, `globalTeardown`, `testTimeout`, `testSequencer`, `maxConcurrency`. Config-relevant flags of the project's `test` script (`--config`, `--env`, `--resetMocks`, …) are honoured everywhere. The babel-jest fallback resolves through Node lookup (pnpm / PnP) and skips presets that are not installed.
**Verified:** `ts-config` and `esm-fn-config` — **fail on the previous code, pass now**; `repo-tsjest`, `repo-cra` (no plain-Jest fallback).

<a id="bug-08"></a>
### BUG-08 🟠 ✅ Stop did not kill Jest
No shell any more; `Executor.kill()` ends the process tree (`taskkill /T` on Windows, process group elsewhere). Records arriving after Stop are dropped; a session token stops every pending batch / retry / fallback. **Verified:** `basic-stop`, `repo-tsjest`, `repo-cra` (no Jest process 3–5 s after Stop, no new process started).

<a id="bug-09"></a>
### BUG-09 🟠 ✅ Coverage 0% race
`setCountedEntry` never downgrades a measured file; change events are debounced (100 ms). **Verified:** `basic-full-run`, `ts-config` (coverage measured).

<a id="bug-10"></a>
### BUG-10 🟠 ✅ Pattern reruns replaced file output
A pattern rerun no longer replaces the file's output; its output goes to the test only when exactly one ran. **Verified:** `basic-on-save`.

<a id="bug-11"></a>
### BUG-11 🟠 ✅ Count drift
`removeFile` decrements the total; `clear()` drops line maps. **Verified:** `basic-on-save` (delete a test file mid-session), unit tests.

<a id="bug-12"></a>
### BUG-12 🟠 ✅ Timeline 0 steps
Shared Windows-safe source pattern, `nameToPattern`, `TRACE_OUTPUT_FILE` passed to Jest (no longer mutating the extension host env), resolved project config, CRA's Jest. Also new: transformers are loaded like Jest does (`createTransformer` + options) and ts-jest gets ambient declarations for the injected globals — TypeScript projects recorded nothing before. **Verified:** `basic-timeline` (plain + `.each`, through the command), `ts-config`, `repo-tsjest`, `repo-cra`.

<a id="bug-13"></a>
### BUG-13 🟠 ✅ Drive-letter case
Reproduced (debug config, and roots vs `--runTestsByPath` in the generated config). Reporter, trace and `--findRelatedTests` paths are mapped back to the store's keys (case-insensitive on Windows); Jest arguments use an upper-case drive. **Verified:** no duplicate entries / no missing files in every scenario; unit test for `findFileKey`.

<a id="bug-14"></a>
### BUG-14 🟠 ✅ Tests and lint
Unit tests (runner: Executor, config helpers; extension: ResultStore, `nameToPattern`) via a small esbuild Jest transformer; root `.eslintrc.cjs`; `pnpm lint` added to PR checks. The tests found one more bug: reverting stale tests to pending left the summary's running count too high (fixed).

<a id="bug-15"></a>
### BUG-15 🔴 ✅ "Finished" while running
Run registry in `SessionManager`: overlapping runs share one progress total (`run-progress`) and one `run-finished`, sent when the last run ends. Stop is final. **Verified:** `basic-save-during-run` (saves during the full suite: one `run-finished`, after the slow file, progress never > 100%), `basic-stop`.

<a id="bug-16"></a>
### BUG-16 🟡 ✅ Large-project performance
Per-file node index in `ResultStore`; views no longer re-send the whole tree on every show; coverage events debounced (BUG-09); see also BUG-29. **Verified:** regression suite; vscode-jest full run 27 s vs 37 s plain Jest.

<a id="bug-17"></a>
### BUG-17 🟡 ✅ `.mjs` / `.cjs` test files
`isTestFile` covers them, and any file `jest --listTests` reports counts as a test file; discovery and its watcher use `testFilePatterns` (JS/TS files only).

<a id="bug-18"></a>
### BUG-18 🟡 ✅ Settings and docs
`showOutputOnFailure` removed (never read); `coverageExclude` declared; CLAUDE.md fixed (no Timeline CodeLens; explicit clicks run without a session, on-save is session-guarded).

<a id="bug-19"></a>
### BUG-19 🟡 ✅ Exit listener per file
Removed (the setup file's `afterAll` flushes coverage).

<a id="bug-20"></a>
### BUG-20 🟡 ✅ CRA transformer options
Shared `toInputConfig` keeps `[path, options]`. **Verified:** unit test.

<a id="bug-21"></a>
### BUG-21 🟡 ✅ Debug leftovers — fixed in `feat/logging-overhaul`.

<a id="bug-22"></a>
### BUG-22 🟡 ✅ Logging — fixed in `feat/logging-overhaul`.

<a id="bug-23"></a>
### BUG-23 🔴 ✅ Endless spinners
- Files show ⟳ when Jest *starts* them (reporter start records), not when queued.
- Every failure path clears its spinners (no result → pending, scoped runs too); Stop reverts all running nodes.
- A save no longer kills the batch running the same file: the newest run owns the file, older results for it are ignored.
- Hangs: a single **test** running longer than `liveTestRunner.hangTimeoutSeconds` (default 300, measured with setup-file heartbeats, so slow file loading doesn't count) is stopped and its file failed with an explanation; the rest of the batch is retried. Plain fallback runs have a 3× wall-clock limit.

**Verified:** `basic-hang` (infinite loop stopped and explained, never-resolving promise fails on Jest's timeout, other files fine), `basic-stop`, `basic-save-during-run`. On copy-requisition the first version (per-file limit) stopped `App.test.js`, which takes 229 s to load even in plain Jest — hence the per-test limit.

<a id="bug-24"></a>
### BUG-24 🟠 ✅ Never-started tests
Jest's `pending` / `todo` map to skipped. `jest --listTests` runs once per session: discovered files the config never runs (e2e specs, ignored folders, `.mjs`) are shown as skipped and never run. `$variable` placeholders of `it.each` tables are understood. **Verified:** `basic-full-run`.

<a id="bug-25"></a>
### BUG-25 🔴 ✅ Whole files of results vanished (new)
**Found by:** vscode-jest showed 165 of 2012 tests. **Cause:** after a file's results were applied, `cleanupStaleNodes` removed every node still "running". A suite stays running while any discovered placeholder under it (e.g. `it.each` named `case $case`) gets no result — and removing a suite removes its subtree, every finished test included. **Fix:** suites are recomputed from their children, swept only when empty. **Verified:** `diag-apply` (200/200 kept), `repo-tsjest`, unit test.

<a id="bug-26"></a>
### BUG-26 🟠 ✅ Same-name tests collapsed (new)
Jest allows identical full names (e.g. `describe.each` with an object). They shared one node and the last result won, so a failure could be hidden. Repeats now get their own node. **Verified:** `repo-tsjest` — 2012/2012 match plain Jest file by file.

<a id="bug-27"></a>
### BUG-27 🟠 ✅ `jest.mock('fs')` broke instrumentation (new)
The coverage flush and trace runtimes `require('fs')` inside the test's module registry. They now use the real `fs` (`jest.requireActual`, captured before the test file loads). **Verified:** `repo-tsjest` (no "appendFileSync is not a function").

<a id="bug-28"></a>
### BUG-28 🟠 ✅ Hooks in `setupTests.js` erased the trace (new)
Project setup files are instrumented; their wrapped `beforeEach` / `afterEach` replaced the running test's trace context. The runtime nests contexts, and our setup file loads first. **Verified:** `diag-trace`, `repo-cra`.

<a id="bug-29"></a>
### BUG-29 🟠 ✅ Transform cache per session (new)
The cache lived in the per-window session folder, so every Start re-transformed the whole project (minutes per file on copy-requisition). It is now per project under the temp root; entries are keyed by the transform's own hash and the config.

<a id="bug-30"></a>
### BUG-30 🟡 ✅ Saves outside the project triggered runs (new)
VS Code saving its own `settings.json` started `jest --findRelatedTests`. Only JS/TS files inside the project root (not `node_modules`) are handled.

<a id="bug-31"></a>
### BUG-31 🔴 ✅ Instrumentation crash failed whole test files (new)
**Found by:** copy-requisition's full run — `App.test.js` and others "failed to run" with `ReferenceError: Container is falsy`. **Cause:** an optional chain inside the call arguments of another optional chain (`a?.b?.c().includes(x?.d())`): the outer rewrite detached the inner node, and branch counting threw. The exception escaped the transform, so every test file importing that module failed. **Fix:** that `?.` is skipped for branch counting; any instrumentation error now falls back to the plain transpiled code (no coverage for that file, tests run normally). **Verified:** `basic-full-run` (`invoice.js` fixture, crashes the old transform); all 421 copy-requisition sources instrument without error.

<a id="bug-32"></a>
### BUG-32 🟠 ✅ Start waited for `jest --listTests` every time (new)
**Found by:** "tests take forever to start". copy-requisition's log: Start waited 20.4 s for `jest --listTests` (added for BUG-24) before the first test ran; 3.7 s even on the 2-file CRA fixture. **Fix:** the answer is kept per project (`RunnableFiles.ts`) under a key of the discovered test files, `package.json` / `jest.config.*` size and mtime, and the run settings; Start asks Jest only when one of those changed. The status bar says "Asking Jest which files it runs…" while it does. **Verified:** `basic-full-run` (second Start uses the list), unit tests for the key.

<a id="bug-33"></a>
### BUG-33 🟠 ✅ A test file created after Start was ignored on save (new)
It was not in the `--listTests` list taken at Start, so the save was dropped as "not run by this project's Jest config". Saving a test file that is not in the list and not already known as excluded now asks Jest again. **Verified:** `basic-on-save`.

<a id="bug-34"></a>
### BUG-34 🟠 ✅ `--findRelatedTests` results went nowhere; coverage stayed "stale" (new)
**Found by:** "coverage data is stale when I hover after saving a source file". Saving a source file with no per-test trace (module-level code only, or a file no test uses) reruns with `jest --findRelatedTests`. Two bugs on that path: the parser read `testFilePath`, but Jest's `--json` calls it `name`, so the results were filed under an empty path (the tree never updated and the total grew by one per save); and only the trace path cleared the stale flag, so the hover said "stale — save to rerun" until the next Start. **Fix:** read `name`; the stale flag is cleared when the save's rerun ends, whatever path it took. **Verified:** `basic-on-save` (`config.js` fixture), parser unit test.

<a id="bug-35"></a>
### BUG-35 🟡 ✅ No time shown on test files (new)
The file row of both test lists shows a duration when the store has one, but nothing ever set it. The whole file's time (Jest's start → end, including loading and hooks) is now stored from every whole-file run; scoped reruns keep the last full time. **Verified:** `basic-full-run` (every file that ran has a time).

---

<a id="bug-36"></a>
### BUG-36 🔴 ✅ Projects opened through a symlink broke on macOS (new)
**Found by:** the e2e suite on macOS — the fixtures live in `os.tmpdir()`, `/var/folders/…`, a symlink to `/private/var/folders/…`. **Cause:** Jest resolves symlinks in its `rootDir`, so it lists, reports and only accepts real paths, while VS Code keeps the path the folder was opened by. Every `--listTests` path looked unknown (all files shown as skipped, nothing ran), `--runTestsByPath` matched nothing (▷ Debug: "No tests found"), and coverage/trace paths never matched the editor's. Hits any project opened through a symlinked folder (macOS or Linux). **Fix:** `runner/src/resolution/JestPaths.ts` records each project root's real path; paths sent to Jest use it (`toJestPathArg`, generated configs' `rootDir`/`roots`, the transform pattern) and every path read back (`--listTests`, JSON results, reporter records, traces, coverage manifests, Timeline steps) is mapped to the editor's spelling. Windows is unchanged (drive-letter case is still handled as in BUG-13). **Verified:** all e2e scenarios on macOS with the default (symlinked) temp folder; unit tests.

<a id="bug-37"></a>
### BUG-37 🔴 ✅ Jest + Vitest projects were treated as Vitest (new)
**Found by:** `@testing-library/jest-dom` (tests with both): "The "vite" framework is not yet supported", 0 files run. **Cause:** `ViteAdapter` matched any `vitest` dependency and is checked before `JestAdapter`. **Fix:** a project is Vitest only when nothing marks it as Jest (no `jest` dependency, no Jest config). `jest.config.cts/.mts/.json` now count as Jest configs. **Verified:** `repo-tsjest` on jest-dom; `frameworkDetector.test.ts`.

<a id="bug-38"></a>
### BUG-38 🟠 ✅ Tests in `__tests__/` folders were not found (new)
**Found by:** jest-dom (`src/__tests__/to-be-checked.js` …). **Cause:** discovery and the default `testFilePatterns` only knew `*.test.*` / `*.spec.*`; Jest's default `testMatch` also runs every JS/TS file in `__tests__`. **Fix:** `**/__tests__/**/*.*` added to the default patterns (and `isTestFile`); on Start, any file `jest --listTests` reports that discovery missed (custom `testMatch` / `testRegex`) is discovered and added (`TestDiscoveryService.addFiles`). **Verified:** `repo-tsjest` on jest-dom (31 files).

<a id="bug-39"></a>
### BUG-39 🔴 ✅ Several Jest projects running one file: last result won (new)
**Found by:** jest-dom runs every test file under a `jsdom` and a `node` project. **Cause:** Jest reports such a file once per project; each report replaced the previous one, so a test that failed under one project and passed under the other could show green. **Fix:** `mergeFileResults` (runner) merges reports of the same file — a test fails if it failed in any project and keeps every project's failure messages; console output is combined. Used by `ResultParser` and the session runner (which counts progress once per file). **Verified:** `repo-tsjest` on jest-dom (▶ Run / ▷ Debug run the test once per project), `mergeFileResults.test.ts`.

<a id="bug-40"></a>
### BUG-40 🔴 ✅ Coverage dropped on every Start after the first (new)
**Found by:** running jest-dom twice: "coverage dropped for 37 file(s) — 37 manifest(s) missing"; vscode-jest showed the same warning without failing the check. **Cause:** BUG-29 keeps Jest's transform cache across sessions, but coverage manifests are written by the transform into the session folder — a cached transform writes none. **Fix:** manifests live next to the transform cache and are named by file path **and content**, so cached code always finds its own manifest; coverage from different versions of a file is no longer merged. **Verified:** `repo-tsjest` twice in a row on jest-dom (new check: no coverage dropped).

<a id="bug-41"></a>
### BUG-41 🟠 ✅ Tooling: pnpm 10+, ESLint, e2e on new VS Code (new)
- **pnpm 10+ refused to install or test:** `@live-test-runner/runner` declared a dependency on `core` it never imports (a cycle: `ERR_PNPM_TASK_CYCLE`), and build-script approval moved from `package.json#pnpm.onlyBuiltDependencies` to `pnpm-workspace.yaml#allowBuilds`. The cycle is removed, approvals moved, and pnpm is pinned with `packageManager` (CI uses it via `pnpm/action-setup`).
- **e2e could not launch VS Code ≥ 1.142 on macOS:** its binary is now `Code`, not `Electron`; the launcher tries both.
- **e2e compared lower-cased paths** with case-sensitive macOS paths (`…/T/…`, `/Users/…`), so plain-Jest comparisons found no files on macOS; the harness keeps case and maps symlinked paths.
- Dependencies updated (Jest 30, ESLint 10 flat config, TypeScript 6.0, esbuild 0.28, `@vscode/test-electron` 3); `tsc` over the extension now passes (the logger class returned by `activate()` was not exported).

<a id="bug-42"></a>
### BUG-42 🔴 ✅ Windows 8.3 short paths: nothing ran (new)
**Found by:** the first real CI run of the e2e suite on `windows-latest` — every scenario failed with Jest's "No files found". **Cause:** the runner's temp folder is `C:\Users\RUNNER~1\…`, an 8.3 short name for `C:\Users\runneradmin\…`. VS Code opened the project by the short name; Jest resolves its rootDir with `realpathSync.native`, which expands it — the same mismatch as BUG-36, which had left Windows out. Users hit it when a project is opened through a short path (e.g. under `%TEMP%` with a long user name), a junction or a `subst` drive. **Fix:** `JestPaths` now applies on Windows too, resolves roots with `realpathSync.native` like Jest, and compares paths case- and slash-insensitively there. The e2e harness maps plain-Jest paths the same way. **Verified:** unit tests simulating the runner's paths; all e2e scenarios still pass on macOS; Windows CI.

<a id="bug-43"></a>
### BUG-43 🔴 🔲 jest-runtime tests fail under the session run (new, open)
**Found by:** the first full `repo-tsjest` run on the Jest monorepo (`node e2e/real-repos.js jest`, 2026-10-20). 470 of 484 files match plain Jest test-for-test; the rest do not, nearly all in `packages/jest-runtime/src/__tests__/` (`runtime_require_module`, `runtime_mock`, `runtime_jest_fn`, `runtime_environment`, `runtime_node_path`, `runtime_require_cache`, `runtime_jest_spy_on`, … — every test fails in the extension, passes in plain Jest), plus `intro.test.js` (4 tests with an unexpected status) and one test in `watch.test.js`. A full session reports 4141 passed / 1122 failed vs plain Jest's 4269 / 1006. **Not a regression:** the 2.0.4-equivalent build (`release/3.0.0` @ `e2ba4ae`) gives the identical totals. **Suspected cause (unverified):** these tests create their own Jest `Runtime` over fixture folders; the session run's injected transform / `setupFilesAfterEnv` (trace + coverage instrumentation) is applied to the whole project root and so also reaches the code those inner runtimes load. **Next step:** run one such file through the session config and compare the failure message with plain Jest. The rest of the scenario passes on the monorepo (▶ Run, ▷ Debug, trace-based save rerun, timeline, Stop).

---

## Still to do

- `test.todo` shares the skipped icon; a distinct todo icon was not added.
- The Jest monorepo (`jest-test-projects/jest`) now runs through the e2e suite (`node e2e/real-repos.js jest`); it fails only on BUG-43.
