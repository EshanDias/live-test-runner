# Live Test Runner (Jest) — VS Code Extension

**Final specification (Wallaby‑lite, on‑save), informed by the architecture and lessons learned from** `firsttris/vscode-jest-runner`.

This document is intentionally written so it can be copied into:
- a new ChatGPT / Copilot conversation
- a `SPEC.md` / `README.md`
- an internal design review

---

## 0. Why review vscode-jest-runner?

The `firsttris/vscode-jest-runner` project demonstrates a **battle‑tested VS Code testing UX**:

- CodeLens & Test Explorer coexistence
- Robust Jest config discovery (AST‑based, not execution)
- Monorepo + multi‑config handling
- Framework adapters instead of hard‑coding Jest logic

Key takeaways we **adopt**, **simplify**, or **explicitly avoid**:

### We adopt

- ✅ Let **Jest decide** what tests exist (`--listTests`, `--findRelatedTests`)
- ✅ Separate **test discovery**, **test execution**, and **UI layers**
- ✅ Support **Test Explorer** and **inline run controls**
- ✅ Monorepo support via **workspace folder selection**

### We simplify (by design)

- ❌ No multi‑framework support (Jest only)
- ❌ No AST parsing of test files or configs
- ❌ No continuous watch / keystroke execution
- ❌ No persistent cache across sessions

This keeps our implementation **smaller, safer, and easier to reason about** while still solving the real pain point: **fast feedback on save**.

---

## 1. Goals

### Must‑have (v1)

1. **Start Testing / Stop Testing** commands
2. **Warm‑up run on Start**
   - Run full Jest suite once
   - Collect coverage
   - Build an **in‑memory affected‑test map**
3. **On‑save execution (only when testing is active)**
   - Save test file → run **that test file only**
   - Save source file → run **affected tests** (map → fallback to Jest related tests)
4. **Test Explorer support** (file‑level at minimum)
5. **Inline diagnostics** (Problems panel + squiggles)
6. **Monorepo support** (user selects project root)

### Explicit non‑goals

- No execution on keystroke
- No unsaved‑buffer execution
- No runtime value instrumentation
- No time‑travel debugging
- No persistence after VS Code closes

---

## 2. Core Concepts

### 2.1 Session‑based testing model

Testing only happens **inside an explicit session**:

- `Start Testing` → enables save listeners
- `Stop Testing` → disables everything and kills processes

No background behavior outside a session.

---

### 2.2 Test discovery: Jest is the source of truth

**Never guess test files solely from filename patterns.**

Discovery order:

1. **Read Jest config (non‑executing)**
   - `jest.config.*` or `package.json#jest`
   - Use `testMatch` / `testRegex` *only as hints*
2. **User override patterns (VS Code settings)**

```json
"liveTestRunner.testFilePatterns": [
  "**/*.test.*",
  "**/*.spec.*"
]
```

3. **Authoritative discovery via Jest**

```sh
jest --listTests
```

Only files returned by Jest appear in Test Explorer.

---

### 2.3 Affected‑test strategy (no instrumentation engine)

We use **coverage‑assisted learning**, not deep runtime instrumentation.

Sources of truth:

- Coverage output from Jest
- `jest --findRelatedTests`

This mirrors the reliable part of `vscode-jest-runner` **without** its complexity.

---

## 3. UX Specification

### 3.1 Commands

| Command | Description |
|---|---|
| Start Testing | Warm‑up run + enable on‑save |
| Stop Testing | Kill processes + disable on‑save |
| Rebuild Map | Full suite with coverage again |
| Refresh Tests | Re‑run `jest --listTests` |
| Select Project Root | For monorepos |
| Run Related Tests | Manual fallback action |

---

### 3.2 Status Bar

States:

- `Live Tests: Off`
- `Live Tests: Starting…`
- `Live Tests: ✅ 12 passed (4.2s)`
- `Live Tests: ❌ 1 failed (2.8s)`

Click → quick actions menu.

---

### 3.3 Test Explorer

Implementation uses **VS Code Testing API**:

- Test tree is **folder‑based**, mirroring the workspace directory structure
- Folder nodes → test file nodes → (optional) suite → test case
- All nodes are **collapsible by default** (handled by VS Code)
- Green / red / running indicators are shown automatically based on reported results

**Test logs & output:**

- Each test run produces an associated **Test Results / Output view** managed by VS Code
- When a test (file/suite/case) is selected, users can view:
  - failure stack traces
  - assertion errors
  - `console.log` / stdout / stderr output
- Output is attached using the `TestRun.appendOutput()` API and displayed contextually

**v1 scope (locked):**

- Folder → file hierarchy only
- File‑level execution only
- Logs attached at file level
- Suite/test‑case nodes may be added later without breaking the model

---

## 4. Execution Rules

### 4.1 On Start Testing

1. Ensure project root selected
2. Discover tests (`jest --listTests`)
3. Run full suite **with coverage enabled**
4. Build in‑memory map
5. Enable save listener

---

### 4.2 On Save

```text
if file is test file:
  run that test file
else:
  if coverageMap has entry:
    run mapped tests
  else:
    run jest --findRelatedTests <file>
```

No rebuild unless user explicitly requests it.

---

### 4.3 From Test Explorer

- Clicking ▶ runs exactly what user selected
- Does **not** rebuild the map
- Updates diagnostics and output

---

## 5. Jest Execution Model

### 5.1 Commands

| Purpose | Command |
|---|---|
| List tests | `jest --listTests` |
| Full run | `jest --coverage` |
| Single test file | `jest path/to/test` |
| Related tests | `jest --findRelatedTests file.ts` |

Command prefix is configurable:

```json
"liveTestRunner.jestCommand": "npx jest"
```

---

### 5.2 Coverage format

Prefer JSON reporters:

```sh
--coverage --coverageReporters=json --coverageReporters=json-summary
```

---

## 6. Coverage Map

### 6.1 Data model

```ts
type CoverageMap = Map<SourcePath, Set<TestPath>>
```

- In‑memory only
- Reset when VS Code closes

---

### 6.2 Map updates

- Warm‑up run → full build
- On‑save runs → incremental merge

Fallback always exists (`--findRelatedTests`).

---

## 7. Architecture

### 7.1 High‑level layers

```text
VS Code UI Layer
 ├─ Commands
 ├─ Status Bar
 ├─ Test Explorer
 ├─ Diagnostics

Execution Layer
 ├─ JestRunner (CLI wrapper)
 ├─ Output parsing

Core Logic
 ├─ TestSession
 ├─ SelectionPolicy
 ├─ CoverageMap
```

---

### 7.2 Folder layout

```text
packages/
 ├─ core/
 │   ├─ TestSession.ts
 │   ├─ CoverageMap.ts
 │   └─ SelectionPolicy.ts
 ├─ runner/
 │   └─ JestRunner.ts
 └─ vscode-extension/
     ├─ extension.ts
     ├─ commands/
     ├─ testExplorer/
     ├─ diagnostics/
     └─ statusBar/
```

---

## 8. Performance & Safety

- Jest always runs in a **child process**
- No heavy parsing in extension host
- Debounce on save (default ~300ms)
- Kill processes on Stop Testing

---

## 9. Settings (Final)

```json
{
  "liveTestRunner.projectRoot": "",
  "liveTestRunner.jestCommand": "npx jest",
  "liveTestRunner.warmupOnStart": true,
  "liveTestRunner.useCoverageMap": true,
  "liveTestRunner.testFilePatterns": ["**/*.test.*", "**/*.spec.*"],
  "liveTestRunner.onSaveDebounceMs": 300,
  "liveTestRunner.showOutputOnFailure": true,
  "liveTestRunner.enableTestExplorer": true
}
```

---

## 10. Acceptance Criteria

- Start Testing builds map
- Saving test runs file
- Saving source runs affected tests
- Test Explorer allows re‑runs
- Monorepo root selection works
- No work outside active session

---

## 11. Final Positioning

Compared to `vscode-jest-runner`, this extension is:

- **Narrower** in scope
- **Predictable** in behavior
- **Session‑based**, not always‑on
- **Designed for speed on save**, not manual invocation

This is intentional and aligned with your original goal.

---

**End of spec.**
