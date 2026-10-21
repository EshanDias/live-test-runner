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
| Coverage (gutter, hover) | ✅ | ✅ | ⏳ 3.0 |
| Live per-file progress | ✅ | ✅ | ✅ |
| Rerun tests related to a saved source file | ✅ | ✅ | ⏳ 3.0.x |
| Monorepo / multi-project | 🟡 | — | 🟡 Vitest `projects`, run from the root |
| Mixed frameworks in one project | — | — | ⏳ 3.2 |
| Execution trace / "covering tests" | ✅ | ✅ | ⏳ 3.3 |
| Timeline debugger | ⏳ | ⏳ | ⏳ 3.4 |
<!-- matrix:end -->

Vitest: version 3 or newer is fully supported; 1.x and 2.x run with results
only (no test listing, related tests or line numbers).
