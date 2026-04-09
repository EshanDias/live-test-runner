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
JestRunner (orchestrator)
  ├── FrameworkDetector     reads package.json → picks adapter from ADAPTER_PRIORITY
  ├── FrameworkAdapter      resolves binary + config for this project type
  ├── BinaryResolver        finds jest in node_modules/.bin
  ├── Executor              spawns Jest child process, reads --outputFile on exit
  └── ResultParser          normalises JSON → JestJsonResult
```

### Framework Adapters

Each adapter implements `FrameworkAdapter`:

| Method | Purpose |
|--------|---------|
| `detect(projectRoot)` | Return true if this adapter handles the project |
| `resolveJestBinary(projectRoot)` | Return absolute path to the Jest executable |
| `resolveJestConfig(projectRoot)` | Return path to a resolved config file, or undefined |
| `getExtraArgs(projectRoot)` | Any extra CLI flags needed |

Current adapters:

| Adapter | Handles | Notes |
|---------|---------|-------|
| `JestAdapter` | Jest, Next.js + Jest | Reads `jest.config.*` or `package.json#jest` directly |
| `CRAAdapter` | Create React App | Runs `--showConfig` once per session to extract the hidden config; caches in memory |
| `ViteAdapter` | Vitest | Stub — not yet implemented |

### Execution

Every run uses this Jest invocation:

```sh
jest --config <resolved> --watchAll=false --forceExit --no-bail --json \
     --outputFile=<tmpfile> --testLocationInResults
```

`--outputFile` is required. Jest's stdout is never parsed — on Windows, large JSON payloads are silently truncated through pipes.

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
2. Add an instance to `ADAPTER_PRIORITY` in `FrameworkDetector.ts`
3. Export from `src/index.ts`

No other files need to change.
