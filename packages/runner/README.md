# `@live-test-runner/runner`

Framework-agnostic Jest execution engine. Finds the right binary, resolves the config, spawns Jest, and returns parsed results. Has no dependency on VS Code.

---

## What it does

Given a project root and a list of test files to run, this package handles everything needed to invoke Jest and return structured results:

1. Detect which framework the project uses (Jest, CRA, etc.)
2. Resolve the Jest binary from the project's own `node_modules`
3. Resolve or extract the Jest config
4. Spawn Jest with deterministic flags
5. Parse the JSON output into typed result objects

---

## Public API

```typescript
import { JestRunner, type JestJsonResult } from '@live-test-runner/runner';

const runner = new JestRunner();
const result: JestJsonResult = await runner.runFile(projectRoot, testFilePath);
```

The extension depends only on the `TestRunner` interface — never on `JestRunner` directly.

---

## Architecture

```
CommandRunner (generic orchestrator)    detection hook, binary/config, chunking, kill, coverage
  └── JestRunner                        Jest flags only (buildArgs per run kind, --listTests parsing)
        ├── FrameworkDetector           reads package.json → picks adapter (CRA before Jest)
        ├── FrameworkAdapter            binary + config + result-file flag + JSON parser + createRunner
        ├── BinaryResolver              resolves Jest's JS entry point (jest/bin/jest.js) from the project
        ├── Executor                    runs it with node (no shell), reads the result file on exit
        └── ResultParser                Jest JSON → RunResult (behind adapter.parseResult)
```

Each command is `[user-command words] [--config …] [adapter extra args] [framework args] [adapter.outputFileArg(tmp)]`; only the framework args come from the runner subclass (`buildArgs({ kind: 'list' | 'full' | 'files' | 'testCase' | 'related' })`). Snapshot tests (`test/jestRunnerArgs.test.ts`) pin the Jest command lines.

### Framework Adapters

Each adapter implements `FrameworkAdapter`. Its `framework` is a `FrameworkId` — an open string id (the shipped ones are in `FRAMEWORK_IDS`), so a new adapter needs no edit to a shared union.

| Method | Purpose |
|--------|---------|
| `detect(projectRoot)` | Return true if this adapter handles the project |
| `resolveBinary(projectRoot)` | Return absolute path to the test runner's entry point / executable |
| `resolveConfig(projectRoot)` | Return path to a resolved config file, or undefined |
| `getExtraArgs(projectRoot)` | Any extra CLI flags needed |
| `outputFileArg(file)` | Flag(s) that make the runner write its JSON result to `file` (Jest: `--outputFile=<file>`) |
| `parseResult(passed, raw, stderr)` | The runner's JSON result → `RunResult` |
| `createRunner(options)` | The `TestRunner` for this framework (Jest, CRA → `JestRunner`) |

Current adapters:

| Adapter | Handles | Notes |
|---------|---------|-------|
| `JestAdapter` | Jest, Next.js + Jest | Jest finds its own config; config-relevant flags of the `test` script (`--config`, `--env`, `--resetMocks`, …) are passed on |
| `CRAAdapter` | Create React App | Runs `--showConfig` once per session to extract the hidden config (transformer options kept); caches in memory; uses react-scripts' own Jest |

Config helpers (`framework/jestConfig.ts`): `toInputConfig()` turns a normalized `--showConfig` project config back into `--config` input form, `pickGlobalConfig()` keeps run-relevant global options, `testScriptJestArgs()` reads the project's `test` script.
| `ViteAdapter` | Vitest | Stub — not yet implemented |

### Execution

Every run uses this Jest invocation:

```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults
```

`--outputFile` is required. Jest's stdout is never parsed — on Windows, large JSON payloads are silently truncated through pipes.

How Jest is started:
- `BinaryResolver.resolveJestEntry(dir)` / `resolveCraJestEntry(projectRoot)` find Jest's JS entry point through `jest/package.json` (Jest's `exports` hides `bin/jest.js`). `.bin` shims and `npx` are fallbacks only.
- `Executor` runs `.js` entry points with `nodeRuntime()` — `node` from PATH, else the editor's runtime with `ELECTRON_RUN_AS_NODE=1` — and **no shell**, so paths with spaces, `^…$` patterns and `a|b` arrive verbatim. Commands that need a shell (a user `jestCommand`, npx) get every argument quoted.
- `kill()` ends the whole process tree (`taskkill /T` on Windows, process group elsewhere). `ExecutorCommand.timeoutMs` stops a run that never finishes; `JestRunner.setFileTimeout()` sets it for single-file runs.
- File arguments go through `toJestPathArg()`: forward slashes, upper-case drive letter (Jest compares against its realpath'd `rootDir`).

`Executor` output handling:
- Pipes use `setEncoding('utf8')`, so multi-byte characters split across chunks stay intact.
- The raw sink (constructor arg) receives **complete lines only**, ANSI-stripped and tagged `[jest#N]`.
- Lines of the form `[LTR:<level>] msg` (written by instrumentation inside Jest) go to the logger at that level and are left out of the captured `stderr`.

### Logging

The runner has no VS Code dependency, so it logs through a replaceable sink:

```ts
import { createLogger, setLogSink } from '@live-test-runner/runner';

const log = createLogger('MyArea');      // log.trace/debug/info/warn/error
setLogSink((level, scope, message, err) => { /* forward anywhere */ });
```

The default sink writes info/warn/error to `console`. The extension installs its own sink at activation. `core` reuses this logger. Helpers: `stripAnsi(text)`, `tail(text, n)` (last *n* non-empty lines, for error context).

### Result types

```typescript
interface JestJsonResult {
  testResults: JestFileResult[];
  numPassedTests: number;
  numFailedTests: number;
  // ...
}

interface JestFileResult {
  testFilePath: string;
  status: 'passed' | 'failed';
  testResults: JestSuiteResult[];
}

interface JestSuiteResult {
  ancestorTitles: string[];
  title: string;
  status: Status;
  duration?: number;
  testResults: JestTestCaseResult[];
}

interface JestTestCaseResult {
  fullName: string;
  status: Status;
  duration?: number;
  location?: { line: number; column: number };
  failureMessages: string[];
}
```

`location` is populated by `--testLocationInResults` and used by `DecorationManager` to place gutter icons on the correct line.

---

## CRA-specific behavior

Create React App hides its Jest configuration. You cannot pass `--json`, `--outputFile`, or `--no-bail` to `react-scripts test`.

`CRAAdapter` solves this by:
1. Running `react-scripts test --showConfig --passWithNoTests` once per session
2. Extracting the embedded Jest config JSON from the output
3. Writing it to a temp file
4. All subsequent runs invoke Jest directly with full flag control

The extracted config is cached in memory. It is invalidated if `package.json` changes.

---

## Adding a new framework

1. Create `src/framework/adapters/YourAdapter.ts` implementing `FrameworkAdapter`
2. Create `src/YourRunner.ts` extending `CommandRunner` (`detectAdapter`, `buildArgs`, `parseTestList`, `coverageFile`) and return it from the adapter's `createRunner`
3. Add an instance to `adapterPriority()` in `FrameworkDetector.ts`
4. Export from `src/index.ts`

No other files need to change.
