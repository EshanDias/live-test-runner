# `@live-test-runner/core`

Shared session and coverage logic used by the VS Code extension.

---

## What it does

This package owns two things:

1. **Session lifecycle** — start, stop, and reset a test session
2. **Coverage map** — an in-memory map from source files to the test files that cover them

---

## Public API

```typescript
import { TestSession, CoverageMap } from '@live-test-runner/core';
```

### `TestSession`

Manages the lifecycle of a single testing session. A session begins when the user clicks Start Testing and ends when they click Stop Testing.

```typescript
const session = new TestSession();
session.start();   // begin session
session.stop();    // end session, clean up
session.reset();   // clear results without ending session
```

### `CoverageMap`

An in-memory `Map<SourcePath, Set<TestPath>>` built from Jest coverage output.

```typescript
const map = new CoverageMap();

// Populate from Jest coverage data
map.update(coverageData);

// Look up which test files cover a given source file
const testFiles = map.getAffectedTests('/src/utils.ts');
// → ['/src/utils.test.ts', '/src/integration/utils.spec.ts']
```

The map is built once during the warm-up run (full suite with coverage) and updated incrementally after each on-save run. When a source file is saved, the extension checks this map first before falling back to `jest --findRelatedTests`.

---

## Design notes

- In-memory only. The map is lost when the session ends or VS Code closes.
- The fallback for an empty or missing map entry is `jest --findRelatedTests <file>`, handled by `SessionManager` in the extension package.
- `SelectionPolicy.ts` is a legacy file with minimal use.

---

## Dependencies

- `@live-test-runner/runner` — for result types used during map construction
