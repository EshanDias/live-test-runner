# `@live-test-runner/core`

Shared session state used by the VS Code extension.

---

## What it does

Framework-neutral: it works with whatever `TestRunner` the extension hands it (Jest's, Vitest's or pytest's).

This package owns **session state** — whether a project's session is on, and the runner it uses.

---

## Public API

```typescript
import { TestSession } from '@live-test-runner/core';
```

### `TestSession`

Whether one project's testing session is on, and the `TestRunner` it uses. A session begins when the user clicks Start Testing and ends when they click Stop Testing. The extension's `SessionManager` drives the runs itself.

```typescript
const session = new TestSession(runner);
session.activate();          // the session is on
session.isTestingActive();   // true
session.stop();              // off, and the runner's processes are killed
```

---

## Design notes

- Which tests a saved source file reruns is not decided here: the extension uses its execution trace, then the framework's related run (`jest --findRelatedTests`, `vitest related`). The old `CoverageMap` (always empty — Jest / Vitest coverage JSON has no per-test data) and `SelectionPolicy` were removed in 3.3.0.

---

## Dependencies

- `@live-test-runner/runner` — the `TestRunner` interface
