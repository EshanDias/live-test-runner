# Framework feature matrix

The single source for the framework table in `packages/vscode-extension/README.md`
and `docs/live-test-runner-guide.html`. Edit the table below, then run
`node scripts/framework-matrix.js` to copy it into both. Every feature PR
flips its cell (plan decision D7).

Cells: ✅ supported · 🟡 partial · ⏳ planned (target release) · — not applicable.

<!-- matrix:start -->
| Feature | Jest | CRA | Vitest |
|---|---|---|---|
| Run & pass/fail | ✅ | ✅ | ✅ |
| ▶ Run / ▷ Debug one test or suite | ✅ | ✅ | ✅ |
| Rerun a saved test file | ✅ | ✅ | ✅ |
| Logs / console output | ✅ per file | ✅ per file | ✅ per test |
| Coverage (gutter, hover) | ✅ | ✅ | ✅ needs `@vitest/coverage-v8` (or `-istanbul`) |
| Live per-file progress | ✅ | ✅ | ✅ |
| Rerun tests related to a saved source file | ✅ | ✅ | ✅ whole test files (`vitest related`) |
| Monorepo / multi-project (project switcher) | ✅ one project per package; a root `projects` config stays one | 🟡 a CRA app is detected as a package (not e2e-tested) | ✅ one project per package; `test.projects` stays one, grouped by name |
| Mixed Jest + Vitest in one project | ✅ each test file runs with its own framework | — | ✅ |
| Execution trace / "covering tests" | ✅ | ✅ | ⏳ 3.3 |
| Timeline debugger | ⏳ | ⏳ | ⏳ later |
<!-- matrix:end -->

Vitest: version 3 or newer is fully supported; 1.x and 2.x run with results
only (no test listing, related tests or line numbers). Coverage uses Vitest's
own provider package; the hover cannot list the covering tests yet (that needs
the execution trace, planned for 3.3). The Timeline debugger for Vitest is planned for a later release.
