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
| Rerun tests related to a saved source file | ✅ | ✅ | ✅ only the tests that ran it (execution trace); `vitest related` when the trace is off |
| Monorepo / multi-project (project switcher) | ✅ one project per package; a root `projects` config stays one | 🟡 a CRA app is detected as a package (not e2e-tested) | ✅ one project per package; `test.projects` stays one, grouped by name |
| Mixed Jest + Vitest in one project | ✅ each test file runs with its own framework | — | ✅ |
| Execution trace / "covering tests" | ✅ | ✅ | ✅ Vitest ≥ 3 (incl. `vitest.workspace` files); not in browser mode |
| UI components (`.vue`, `.svelte`, `.astro`, `.marko`): save reruns, trace, coverage | ✅ through the project's transformer (vue-jest, svelte-jester…) | — (React is plain JS) | ✅ through the project's Vite plugins |
| Timeline debugger | ⏳ | ⏳ | ⏳ later |
<!-- matrix:end -->

Vitest: version 3 or newer is fully supported; 1.x and 2.x run with results
only (no test listing, related tests, trace or line numbers). Coverage uses
Vitest's own provider package. The execution trace (covering tests in the
hover, precise reruns on save) is on by default (`liveTestRunner.vitestTrace`);
it adds a Vite plugin through a wrapper config (Vitest 3 workspace files
included; type-check `*.test-d.ts` files are fine) and turns itself off for a
project it cannot reach (a broken run) — saves then use `vitest related`.
Browser-mode projects (opt-in) run without it. The Timeline debugger for
Vitest is planned for a later release.

UI frameworks: any. React, Preact, Solid, Lit, Angular and Qwik code is plain
JS / TS; single-file components (Vue, Svelte, Astro, Marko) are compiled by the
project's own Jest transformer or Vite plugin and mapped back to their own
lines; any other extension the Jest config loads (`moduleFileExtensions`) or the
Vitest trace sees counts too. Jest's ESM mode (`NODE_OPTIONS=--experimental-vm-modules`
in the test script, or `node-options` in `.npmrc`) is honoured.
