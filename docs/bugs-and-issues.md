# Bugs & Issues — Analysis

> Audit of the whole app (runner · core · extension · instrumentation), done on branch `feat/logging-overhaul` (2026-10-19).
> Each entry has: **symptom → root cause → fix → how to verify**. Work through them one at a time; remove an entry once it is fixed and verified.

**Severity:** 🔴 High (wrong results / feature broken) · 🟠 Medium (flaky or misleading) · 🟡 Low (cleanup / polish)
**Status:** ✅ fixed in `feat/logging-overhaul` · 🔲 open · 🔍 needs reproduction first

---

## Index

| ID | Sev | Status | Title |
|----|-----|--------|-------|
| [BUG-01](#bug-01) | 🔴 | ✅ | Console logs sometimes don't appear in the Results panel |
| [BUG-02](#bug-02) | 🔴 | ✅ | Output channel shows symbols / garbage instead of letters |
| [BUG-03](#bug-03) | 🔴 | 🔲 | Windows: test-name patterns are mangled by `cmd.exe` (scoped reruns run the wrong tests) |
| [BUG-04](#bug-04) | 🔴 | 🔲 | Per-test trace is never recorded → smart reruns and "covering tests" never work |
| [BUG-05](#bug-05) | 🔴 | 🔲 | CodeLens **▷ Debug** always debugs the whole file |
| [BUG-06](#bug-06) | 🔴 | 🔲 | Debug launch config is broken on Windows, in sub-folder roots and for CRA |
| [BUG-07](#bug-07) | 🔴 | 🔲 | `jest.config.ts` / `.mjs` / `.json` / function configs are ignored by the instrumented runner |
| [BUG-08](#bug-08) | 🟠 | 🔲 | Windows: **Stop** does not kill Jest; results keep arriving after Stop |
| [BUG-09](#bug-09) | 🟠 | 🔲 | Coverage randomly shows 0% for files that were tested (scan vs. run race) |
| [BUG-10](#bug-10) | 🟠 | 🔲 | Scoped reruns overwrite the file's console output with a partial set |
| [BUG-11](#bug-11) | 🟠 | 🔲 | Test count drifts up after files are deleted / re-discovered |
| [BUG-12](#bug-12) | 🟠 | 🔲 | Timeline Debugger records 0 steps on Windows and for `.each` / template-named tests |
| [BUG-13](#bug-13) | 🟠 | 🔍 | Windows drive-letter case mismatch can make a whole batch look "missing" |
| [BUG-14](#bug-14) | 🟠 | 🔲 | `pnpm test` / `pnpm lint` always fail (no tests, no ESLint config) — PR checks can never pass |
| [BUG-15](#bug-15) | 🔴 | 🔲 | "Finished" shown while tests are still running |
| [BUG-23](#bug-23) | 🔴 | 🔲 | Tests spin ("running") forever |
| [BUG-24](#bug-24) | 🟠 | 🔲 | Some tests never start (stay ○ pending) |
| [BUG-16](#bug-16) | 🟡 | 🔲 | Large projects: result application is O(tests × nodes); coverage scan floods the webview |
| [BUG-17](#bug-17) | 🟡 | 🔲 | Saving an `.mjs` / `.cjs` test file is treated as a source file |
| [BUG-18](#bug-18) | 🟡 | 🔲 | Dead / undocumented settings and doc mismatches |
| [BUG-19](#bug-19) | 🟡 | 🔍 | `process.on('exit')` listener added once per test file |
| [BUG-20](#bug-20) | 🟡 | 🔲 | CRA: transformer options are dropped when the config is extracted |
| [BUG-21](#bug-21) | 🟡 | ✅ | Debug leftovers: `console.log` on every editor redraw, debug dump on every timeline run |
| [BUG-22](#bug-22) | 🟡 | ✅ | Logs were noisy, single-level and partly invisible |

---

## Fixed in this branch

<a id="bug-01"></a>
### BUG-01 🔴 ✅ Console logs sometimes don't appear in the Results panel

**Symptom** — `console.log` output shows after **Start Testing**, but disappears after saving a test file, rerunning a single file, or always (in some projects).

**Root cause** — Jest switches to *verbose* mode on its own when **exactly one test file** runs, and also when the project config has `verbose: true`. In verbose mode Jest prints console calls straight to the terminal (`CustomConsole`) and leaves `testResult.console` empty. `liveReporter.js` reads `testResult.console`, so the Results panel gets nothing.
- Full runs use batches of 5–50 files → not verbose → logs shown.
- Saving a test file runs a batch of 1 → verbose → logs gone. That's the "sometimes".

**Evidence** — reproduced against Jest 29 with one test file: reporter record had **0** console entries without the flag, **2** with `--verbose=false`.

**Fix (done)** — `SessionTraceRunner.runFiles` now passes `--verbose=false` ([SessionTraceRunner.ts](../packages/vscode-extension/src/session/SessionTraceRunner.ts)). The Executor also forwards child **stdout** to *Jest Output*, so anything printed directly is no longer lost.

**Verify** — start a session, open a test with a `console.log`, save the test file → its log shows in the Results panel. Repeat in a project with `verbose: true` in its Jest config.

> Related, still open: [BUG-10](#bug-10) (scoped reruns replace the file-level output).

---

<a id="bug-02"></a>
### BUG-02 🔴 ✅ Output channel shows symbols / garbage instead of letters

**Symptom** — `�` characters, `[31m`/`[39m` sequences, or lines cut in half in the Output panel.

**Root causes (three)**
1. **Split UTF-8 characters** — `Executor` decoded every stdout/stderr chunk with `Buffer.toString()`. Jest's `✓ ✕ ● ›` are 3-byte characters; when a chunk boundary falls inside one, both halves decode to `U+FFFD` (`�`). Verified: `[0xE2] + [0x9C,0x93]` → `"���"` instead of `"✓"`.
2. **ANSI colour codes** — the channel was created with language id `ansi`, but VS Code's Output panel does not render ANSI. Whenever colour was on (e.g. `FORCE_COLOR` set in the environment), escape codes showed up as text.
3. **No line buffering** — chunks were written as they arrived. With up to `cpus/4` Jest processes running at once, half-lines from different processes interleaved.

**Fix (done)** — [Executor.ts](../packages/runner/src/execution/Executor.ts):
- `setEncoding('utf8')` on both pipes (Node's `StringDecoder` handles split characters).
- A `LineSplitter` emits only complete lines; ANSI is stripped (`stripAnsi`).
- Every line is tagged with its process: `[jest#12] PASS src/a.test.ts`, so concurrent output can be told apart.
- Raw Jest output moved to its own channel, **Live Test Runner: Jest Output**.

**Verify** — run a suite with failures and `console.log('✓ ünïcödé')` on Windows and macOS. *Jest Output* has no `�` and no `[3xm`.

---

<a id="bug-21"></a>
### BUG-21 🟡 ✅ Debug leftovers

- `CoverageDecorationManager._refreshEditor` ran `console.log` (two store lookups) on **every** editor refresh. Removed.
- `JestInstrumentedRunner` wrote `ltr-debug.log` (the full generated config plus all Jest output) on **every** timeline run. Now it is written only when the log level is Debug, and its path is logged.

<a id="bug-22"></a>
### BUG-22 🟡 ✅ Logs were noisy, single-level and partly invisible

- About 20 `[Coverage]` INFO lines per batch, a "Cache hit" line per test file, a "module loaded / Instrumenting / OK" line per transformed file, plus a PASS/FAIL dump that repeated Jest's own output.
- Runner/core logs went to `console` only (DevTools), so warnings like the "npx fallback" were invisible to users.
- Logs written before the channel existed (stale-dir cleanup) were lost.

Fixed by the logging overhaul. See the **Logging** section in [developer-guide.md](developer-guide.md).

---

## Open — High

<a id="bug-03"></a>
### BUG-03 🔴 Windows: test-name patterns are mangled by `cmd.exe`

**Symptom (Windows)** — ▶ Run on a single test or suite, or a trace-based on-save rerun, runs the wrong tests, runs nothing, or errors with `'xyz' is not recognized as an internal or external command`. Paths containing spaces (`C:\Users\John Smith\…`) can also break.

**Root cause** — [Executor.ts](../packages/runner/src/execution/Executor.ts) spawns `.cmd` shims with `shell: true`. Node then **joins the args with spaces and does no quoting** (Node 24 warns: `DEP0190`). `cmd.exe` then:
- splits `^Math utils adds numbers$` into 4 args,
- treats `^` as its escape character and removes it,
- treats `|` (used to combine several test names in `_runTestCases`) as a **pipe**.

**Evidence** — sent `["--testNamePattern","^Math utils adds numbers$","--x","a^b"]` → the `.cmd` received `["--testNamePattern","Math","utils","adds","numbers$","--x","ab"]`. Sending `a|b` gave: `'b' is not recognized as an internal or external command`.

**Fix** — don't go through `cmd.exe`. Resolve the real JS entry point (`require.resolve('jest/bin/jest.js', { paths: [projectRoot] })`, or for CRA `react-scripts/node_modules/jest/bin/jest.js`) and spawn `process.execPath` with it, without a shell. Keep `shell: true` only for a user-supplied `jestCommand`, and quote each arg yourself in that case.

**Verify** — on Windows, ▶ Run a test whose name has spaces → only that test reruns. Save a source file that two tests in one file depend on (combined `a|b` pattern).

---

<a id="bug-04"></a>
### BUG-04 🔴 Per-test trace is never recorded

**Symptom** — on-save reruns always run whole files through `jest --findRelatedTests` (debug log: *"No trace data … using jest --findRelatedTests"*). The coverage hover never lists covering tests. **Show All Covering Tests** is always empty. `Dump Trace Store` shows empty `sourceToTests`.

**Root cause** — the trace runtime records hits only between `__strace.enterTest()` and `exitTest()` ([sessionTraceRuntime.js](../packages/vscode-extension/src/session/instrumentation/sessionTraceRuntime.js) — `step()` returns early while `_hits` is null). Those wrappers are injected around `test()`/`it()` callbacks by `instrumentAST` pass 1, but test files are deliberately **not** instrumented ([sessionTraceTransform.js](../packages/vscode-extension/src/session/instrumentation/sessionTraceTransform.js) `IS_TEST_FILE_RE` branch, done to avoid the `jest.mock` hoisting problem). So `enterTest` never runs and no `T`/`H` records are written. Coverage counters (`__cov`) are unaffected; they don't depend on test context.

**Fix** — open and close the test context from the setup file instead of from injected code. In `ltrCoverageSetup.js`:
```js
beforeEach(() => global.__strace?.enterTest(expect.getState().currentTestName, expect.getState().testPath));
afterEach(() => global.__strace?.exitTest());
```
`currentTestName` is space-joined, which matches `ResultStore.fullName`. Also load the runtime from the setup file so `__strace` exists even when no source file is instrumented.

**Evidence** — ran Jest 29 with the session transform, setup and reporter on a test that calls an instrumented `sum.js`. Results, console and coverage counters were all written; the trace file (`SESSION_TRACE_FILE`) was **not** created.

**Verify** — enable `liveTestRunner.devMode`, run, then `Dump Trace Store (Debug)` → `sourceToTests` is populated. Save a source file → debug log shows *"Trace-based rerun … N individual test(s)"*.

---

<a id="bug-05"></a>
### BUG-05 🔴 CodeLens ▷ Debug always debugs the whole file

**Root cause** — [CodeLensProvider.ts:58](../packages/vscode-extension/src/editor/CodeLensProvider.ts#L58) passes `[filePath, node.fullName]`, but the `liveTestRunner.debugFromEditor` handler is `(filePath, line)`. `getLineMap().get("<name>")` misses, `_resolveNodeAtLine` calls `doc.lineAt(NaN)` and throws, the error is caught, and the whole file is debugged with no name filter.

**Fix** — pass `line` (the CodeLens already has it), or add a `debugTest(filePath, fullName)` command and call `session.debugFromEditor(filePath, fullName)` directly.

**Verify** — ▷ Debug on one test → only that test runs under the debugger.

---

<a id="bug-06"></a>
### BUG-06 🔴 Debug launch config is broken on Windows, in sub-folder roots and for CRA

**Root cause** — [JestAdapter.ts:198](../packages/vscode-extension/src/framework/JestAdapter.ts#L198) `getDebugConfig` has three problems:
- `program: '${workspaceFolder}/node_modules/.bin/jest'`: on Windows `.bin/jest` is a **shell script**, and Node fails with `SyntaxError`.
- It uses `workspaceFolder`, not `projectRoot`, so it breaks when `liveTestRunner.projectRoot` points to a sub-folder or monorepo package.
- CRA projects need react-scripts' bundled Jest plus the extracted config, and neither is used.
- Smaller: the name filter uses `escapeRegex`, not `nameToPattern`, so `test.each` / template names never match.

**Fix** — resolve `jest/bin/jest.js` from `projectRoot` (same resolver as BUG-03), set `cwd: projectRoot`, add `--config <resolved>` for CRA, and use `nameToPattern`.

**Note** — Debug is now logged. If VS Code refuses to start the session, the log shows `Debug: VS Code refused to start the debug session (program: …)`.

---

<a id="bug-07"></a>
### BUG-07 🔴 Other Jest config formats are ignored by the instrumented runner

**Symptom** — in TypeScript / ESM projects every batch "produces no results" and everything falls back to plain Jest, one file at a time. Runs are slow, and there is no coverage and no smart rerun. The new logs show it as:
`WARN [Runner] b3: instrumented Jest run returned no results … Jest said: …` then `WARN [Session] … falling back to plain Jest`.

**Root cause** — the generated temp config ([SessionTraceRunner.ts](../packages/vscode-extension/src/session/SessionTraceRunner.ts) `configContent`, and the timeline equivalent in [JestInstrumentedRunner.ts](../packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts)) only `require`s `jest.config.js`, `jest.config.cjs` and `package.json#jest`. Not handled:
- `jest.config.ts` / `.mts` / `.cts` / `.mjs` / `.json`,
- a `--config` passed in the project's `test` script,
- configs that export a **function** (sync or async). Spreading a function gives `{}`,
- `projects: [...]` multi-project configs.

When the base config is lost, the project's `transform`, `moduleNameMapper`, `testEnvironment` and `setupFiles` are lost with it.

**Related** — when no project transformer matches, the babel-jest fallback in `sessionTraceTransform.js` / `traceTransform.js` loads `path.join(rootDir, 'node_modules', 'babel-jest')`, a fixed path. Under **pnpm** (not hoisted) or Yarn PnP that path doesn't exist, so files run untranspiled (fatal for TS/ESM). Use `require.resolve('babel-jest', { paths: [rootDir] })` and the same for the presets. The log now shows this as `WARN … babel-jest fallback failed (files run untranspiled)`, collapsed to a single line.

**Fix** — read the config the way Jest does: run `jest --showConfig` once per session and cache it (this already exists for CRA in `CRAAdapter`), then layer our transform/reporter/setup on top. Alternatively, make the generated config an `async` function that `await`s the user's config (works for function exports and `.mjs`).

**Verify** — a ts-jest project with `jest.config.ts`: no "no results" warning, and coverage appears.

---

## Open — Medium

<a id="bug-08"></a>
### BUG-08 🟠 Windows: Stop does not kill Jest

**Root cause** — with `shell: true`, `child.kill()` kills `cmd.exe` only, and the Node/Jest grandchild keeps running. Its stdout pipe stays open, so the Executor keeps polling the reporter file and **results keep landing in the tree after Stop**. Separately, fallback runs started through `JestAdapter` (a new `JestRunner` per call) are never tracked by `SessionTraceRunner.kill()`, and pending save timers are not cleared on stop.

**Fix** — spawn without a shell (BUG-03 fix), or kill the whole tree on win32 (`taskkill /pid <pid> /T /F`). Track adapter-run executors in a kill-list. Clear `_saveTimers` in `stop()`. Ignore records that arrive after Stop.

**Verify** — start a long suite on Windows, click Stop, then check Task Manager → no `node.exe` Jest processes left.

---

<a id="bug-09"></a>
### BUG-09 🟠 Coverage randomly shows 0% for tested files

**Root cause** — `SourceCounter.run()` (scan of every source file at session start) runs **in parallel** with the first test run and calls `setCountedEntry` unconditionally ([SourceCounter.ts](../packages/vscode-extension/src/coverage/SourceCounter.ts)). If a batch has already marked `foo.ts` as *measured*, the scan reaching `foo.ts` later overwrites it with *counted* (0 hits). The outcome depends on timing, so it's flaky.

**Fix** — in `setCountedEntry`, skip when an entry is already `measured` / `measured-stale`.

**Also** — `setCountedEntry` fires `onDidChange` **per file**, and each fire re-sends *all* coverage rows to the webview. That's O(N²) traffic on big repos. Debounce it (~100 ms).

---

<a id="bug-10"></a>
### BUG-10 🟠 Scoped reruns overwrite the file's console output

**Root cause** — `_runTestCases` runs `kind: 'pattern'` reruns with `{ fullNames }` and no `nodeId`, so `JestAdapter._applyFileResult` ends in `store.setFileOutput(filePath, output)` ([JestAdapter.ts:393](../packages/vscode-extension/src/framework/JestAdapter.ts#L393)). The file-level logs are replaced by the logs of the 2–3 tests that reran. This breaks the "per-scope output / never back-fill" rule in CLAUDE.md.

**Fix** — for pattern runs, store output on each matched test node (or keep the file output and only replace it on whole-file runs).

---

<a id="bug-11"></a>
### BUG-11 🟠 Test count drifts up

**Root cause** — `ResultStore.removeFile` ([ResultStore.ts](../packages/vscode-extension/src/store/ResultStore.ts)) decrements passed/failed/running but **not `_summary.total`**. Each deleted or ghost-pruned file inflates the total. Separately, `clear()` (used on workspace-folder change) doesn't clear the line maps, so stale gutter icons and CodeLens stay.

**Fix** — `this._summary.total--` for each removed test node. Call `this._lineMap.clear()` in `clear()`.

---

<a id="bug-12"></a>
### BUG-12 🟠 Timeline Debugger records 0 steps on Windows / for `.each` tests

**Root causes** in [JestInstrumentedRunner.ts](../packages/vscode-extension/src/timeline/JestInstrumentedRunner.ts):
- `srcTransformPattern` is `^c:/Users/…` with the exact drive case and `/` only. The session runner already has the Windows-safe version (`[cC]:` and `[/\\]`), but the timeline doesn't.
- `--testNamePattern ^escapeRegex(name)$`: names containing `%s`, `$var` or `<dynamic>` never match. Use `nameToPattern`.
- `process.env.TRACE_OUTPUT_FILE = …` mutates the **extension host** env. Every other Jest spawned during a trace inherits it, and two traces race. Pass it via `extraEnv`.
- Same config-format gap as BUG-07.

The new log line `WARN [Timeline] Trace finished … captured 0 steps` makes this visible now.

---

<a id="bug-13"></a>
### BUG-13 🟠 🔍 Windows drive-letter case mismatch

**Suspicion** — store keys come from VS Code (`c:\…`). `SessionTraceRunner.onRecord` only `path.normalize`s `rec.testFilePath`, while `JestRunner.normalisePath` **uppercases** the drive (`C:/…`) for the plain-Jest path. If Jest reports `C:\…`:
- `received.has(fp)` misses → the whole batch counts as missing → **every file runs twice** (instrumented + fallback),
- `runRelatedTests` applies results to `fileResult.testFilePath` → a **duplicate file entry** can appear in the tree.

**Reproduce first** — on Windows at Debug level, look for `b<N>: done … 0/<N> file(s) reported` together with PASS lines in *Jest Output*. If it reproduces, normalise both sides with one helper (lowercase drive + `path.normalize`) everywhere a path becomes a key.

---

<a id="bug-14"></a>
### BUG-14 🟠 `pnpm test` always fails (and `pnpm lint` too)

**Root cause** — `core` and `runner` run `jest` and have no test files, so Jest exits 1 with *"No tests found"*. The PR-checks workflow requires `pnpm test` to pass, so every PR would fail once enforcement is on. Also, `pnpm lint` fails in every package with *"ESLint couldn't find a configuration file"* because no `.eslintrc` exists in the repo. Both fail the same way on `main`.

**Fix** — add real unit tests. Good first targets: `LineSplitter`/`stripAnsi`, `ResultParser`, `nameToPattern`, `ResultStore` summary counts. Until then, use `jest --passWithNoTests`. Add a root `.eslintrc.cjs` with `@typescript-eslint`, or remove the lint scripts.

---

<a id="bug-15"></a>
### BUG-15 🔴 "Finished" shown while tests are still running

**Symptom** — the progress bar disappears and the summary or status bar looks final, but some tests are still spinning or results keep arriving.

**Root causes**
1. **No notion of "a run in progress"**. Every entry point (`start`, `onSave`, `rerunScope`, `_runAffectedBySourceFile`, `_runTestCases`) runs on its own, and each `_runFiles` / `_runTestCases` call ends with its own `onRunFinished` + status bar update ([SessionManager.ts](../packages/vscode-extension/src/session/SessionManager.ts)). Saving any file during the full run starts a second run. When that one finishes, the webview receives `run-finished` ([testListView.js](../packages/vscode-extension/src/webview/views/testListView.js) `case 'run-finished'`): it hides the progress bar, switches to *watching*, and shows the summary. Meanwhile the full suite is still running.
2. **One user action can finish twice.** A source-file save can call `_runFiles` *and then* `_runTestCases`, and each sends `run-finished`. The trace-less path (`runRelatedTests`) sends another.
3. **Wrong progress counts.** `_runTestCases` sends `onFileResult` right after marking nodes *running* ("Mark affected nodes as running"), and the webview adds +1 to `_completedFiles` for every `batch-file-results`. `_totalFiles` is only set by the full run's `run-started`. So partial reruns show numbers like `Running — 61 / 58`.
4. **Stop is not final.** After Stop, an in-flight batch returns every file as "missing", and `runBatch` then falls back to **plain Jest for each file**: tests run again *after* Stop ([BUG-08](#bug-08) is the Windows variant). `SessionManager` never checks `isActive()` before the fallback.

**Fix**
- Add a run registry in `SessionManager`: `Set<runId>`, plus a total and completed count per run. Send `run-started` when the set goes empty → non-empty, and send `run-finished` / set the final status bar only when it goes back to empty. Partial reruns add to the running totals.
- Only send `onFileResult` when a result arrived. Use `onFilesRerunning` for "now running".
- In `runBatch`, check `this.isActive()` before any fallback or retry, and skip it once stopped.

**Verify** — start the full suite, save a source file mid-run: the progress bar stays until *everything* is done. Stop mid-run: Jest Output shows no new `jest#N` processes after Stop.

---

<a id="bug-23"></a>
### BUG-23 🔴 Tests spin ("running") forever

**Symptom** — ⟳ never turns into ✓/✗, both in the tree and in the gutter. It's unclear whether the test is slow or stuck.

**Root causes** (several, all ending in nodes left `running` in `ResultStore`)
1. **Queued files are shown as running.** `_runFiles` calls `store.fileStarted()`, which marks *every* file in the run as running before the first batch starts. Each batch is one Jest process with `--maxWorkers=1`, so its files run **one after another**. Concurrency is `cpus/4` batches and a batch holds up to 50 files. On an 8-core machine that's 2 files actually executing while up to 100 show ⟳, and the rest wait. They look stuck but haven't started.
2. **Hard failures never clear the spinner.** Node cleanup (`cleanupStaleNodes`) only happens inside `_applyFileResult`. Each of these paths skips it, leaving the file's nodes `running` until the next Start:
   - `JestAdapter.runFile`: no `fileResult` → `return 'failed'`
   - the `SessionManager` catch path: `store.fileResult(fp, 'failed')` sets the *file* status only
   - `JestAdapter.runTestCase`: no `fileResult` → just a warning (this is how a Windows-mangled pattern, [BUG-03](#bug-03), turns into a permanent spinner)
3. **Stop leaves spinners.** `stop()` doesn't reset `running` nodes, so they spin until the next Start (and fallback runs may keep updating them, BUG-15 #4).
4. **A save cancels a whole batch.** Saving `a.test.ts` while it runs in batch `b3` kills `b3` (all of it, up to 50 files). Its unfinished files come back as missing and are retried, by splitting the batch or falling back to plain Jest **one file at a time**. Those files can spin for minutes. *Now logged:* `b7: a.test.ts was still running in b3 — cancelling b3; its unfinished files will be retried`.
5. **Genuinely hung tests have no time limit.** `Executor.spawn` has no overall timeout. Instrumented runs raise `testTimeout` to ≥30 s, so a never-resolving promise costs 30 s *per test*. An infinite loop never ends, and it holds a worker slot, which also blocks queued batches (see [BUG-24](#bug-24)).
6. **Results can be dropped by key mismatch**: if Jest's reported path differs from the store key ([BUG-13](#bug-13)), `BaseWebviewProvider.onFileResult` drops the result (`store.getFile()` is undefined), so the webview spinner stays.

**Diagnostics added (this branch)**
- `liveReporter.js` now writes a `start` record when Jest *begins* a file.
- `SessionTraceRunner` runs a watchdog. When no file has finished for 60 s it logs, e.g. `WARN [Runner] b3: no file has finished in 60s — 12/40 done, currently on checkout.test.ts (58s in that file)`. It repeats every 2 min while stuck. **Slow tests show progress between warnings; a hang repeats the same file.**
- Batch cancellations are logged at INFO (cause 4).

**Fix**
- Mark a file `running` when its *start* record arrives (the reporter now sends it), and mark queued files `queued`. This needs a new UI state, or just leave them pending.
- Add a `finally` in every adapter path: on no result, call `cleanupStaleNodes(file, false)` (reverts to `pending`) and log a WARN.
- On `stop()`, revert all `running` nodes to `pending`.
- Re-queue only the *saved* file instead of killing a shared batch (or batch on-save runs separately from the full run).
- Optional per-batch hard timeout (e.g. `max(5 min, files × 60 s)`) that kills the batch and marks the current file failed with "timed out — possible hang".

**Verify** — add a test with `await new Promise(() => {})` and one with `while (true) {}`. The first fails after 30 s; for the second the watchdog names the file, and after the fix the timeout marks it failed and the rest of the batch continues.

---

<a id="bug-24"></a>
### BUG-24 🟠 Some tests never start (stay ○ pending)

**Root causes**
1. **Skipped tests look identical to not-run tests.** Jest reports `test.skip` / `xit` / tests skipped by `.only` as status **`pending`**, and `test.todo` as `todo`. `JestAdapter._applyFileResult` maps only the literal `skipped` to *skipped*, and everything else to *pending* ○, the same icon as "never ran".
2. **Files Jest refuses to run.** Discovery globs `*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}` across the whole project. The instrumented config deletes the project's `testMatch` / `testRegex`, so Jest falls back to its **default `testMatch`**, which excludes `.mjs`/`.cjs`. The project's `testPathIgnorePatterns` is kept, and `--runTestsByPath` still applies it. The result:
   - E2E specs (Playwright/Cypress `*.spec.ts`), ignored folders and `.mjs` tests appear in the tree, but Jest never runs them.
   - They come back "missing" → plain-Jest fallback → "No tests found" → no result → stuck pending/running (BUG-23 #2).
3. **Queued behind a slow or hung batch.** Batches are drained by a fixed pool of `cpus/4` workers. A batch stuck on a hanging test (BUG-23 #5) holds its slot, and the remaining batches sit in the queue as *pending*.
4. **Discovered names that Jest names differently**, e.g. computed titles or `describe.each` placeholders that never match a real result. These are removed on cleanup, but only when the file produced results.

**Fix**
- Map Jest's `pending`/`todo` → `skipped` (and show a distinct icon for todo).
- Ask Jest which files it would run: `jest --listTests` with the *project's* config, once per session. This already exists as `JestAdapter.discoverTests` → `JestRunner.discoverTests`, but nothing calls it. Show files outside that set greyed out as "not run by Jest config" instead of running them.
- With the watchdog (BUG-23) in place, a blocked worker is visible in the log.

**Verify** — a file with `test.skip` shows the skipped icon. A Playwright `e2e/*.spec.ts` doesn't spin and is marked "not a Jest test".

---

## Open — Low

<a id="bug-16"></a>
### BUG-16 🟡 Large-project performance
- `JestAdapter._applyFileResult` calls `store.getFileNodes(filePath)`, a scan of **all** nodes, per ancestor per test case ([JestAdapter.ts:260](../packages/vscode-extension/src/framework/JestAdapter.ts#L260)). `cleanupStaleNodes` scans all nodes several times. On 10k+ tests, applying results blocks the extension host. Add a per-file node index.
- `BaseWebviewProvider.onDidChangeVisibility` re-sends the entire tree on every show.
- Coverage scan flooding: see BUG-09.

<a id="bug-17"></a>
### BUG-17 🟡 `.mjs` / `.cjs` test files treated as source files
Discovery globs `*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}`, but `JestAdapter.isTestFile` only matches `[jt]sx?`. Saving `foo.test.mjs` runs `--findRelatedTests` instead of the file. Also, the `testFilePatterns` setting is read by `getFileGlob()`, which nothing calls: discovery uses a hard-coded glob.

<a id="bug-18"></a>
### BUG-18 🟡 Dead / undocumented settings and doc mismatches
- `liveTestRunner.showOutputOnFailure` is declared but never read.
- `liveTestRunner.coverageExclude` is read by `SourceCounter` but not declared in `package.json`, so users can't discover it.
- CLAUDE.md lists a `⏱ Timeline` CodeLens, which doesn't exist. The timeline opens from the Results panel.
- CLAUDE.md says CodeLens actions are session-guarded, but `rerunScope` runs without an active session. Decide which is intended and align.

<a id="bug-19"></a>
### BUG-19 🟡 🔍 `process.on('exit')` per test file
`sessionTraceRuntime.js` is `require`d by every instrumented module, in a fresh module registry per test file, and each load registers a `process.on('exit')` handler. In long batches this may trigger `MaxListenersExceededWarning` and N duplicate coverage flushes. `ltrCoverageSetup`'s `afterAll` already flushes, so the exit handler can probably go. Check the Jest Output for the warning first.

<a id="bug-20"></a>
### BUG-20 🟡 CRA transformer options dropped
`CRAAdapter.normalizeTupleMap` maps `[pattern, path, options]` tuples to `{ pattern: path }`, which drops `options`. Keep `[path, options]` when present. `SessionTraceRunner` already does this correctly.

---

## Suggested order

1. **BUG-03 + BUG-08 + BUG-06** — one change: spawn Jest's JS entry with `node`, no shell. Fixes Windows patterns, Stop, and Debug together.
2. **BUG-15 + BUG-23 + BUG-24** — run lifecycle: run registry, "running only when started", cleanup on every failure path, skipped ≠ pending. This is the "finished but still running / spinning forever / never started" group.
3. **BUG-07** — config loading. Biggest cause of slow "fallback" runs.
4. **BUG-04** — enables the smart-rerun and covering-tests features.
5. **BUG-05, BUG-09, BUG-10, BUG-11** — small, contained fixes.
6. **BUG-14** — add tests (start with the new `LineSplitter` / `stripAnsi`), then the rest.
