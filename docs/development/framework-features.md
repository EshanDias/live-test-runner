# Framework feature matrix

The single source for the framework table in `packages/vscode-extension/README.md`
and `docs/live-test-runner-guide.html`. Edit the table below, then run
`node scripts/framework-matrix.js` to copy it into both. Every feature PR
flips its cell.

Cells: ✅ supported · 🟡 partial · ⏳ planned (target release) · — not applicable.

<!-- matrix:start -->
| Feature | Jest | CRA | Vitest | Angular | pytest |
|---|---|---|---|---|---|
| Run & pass/fail | ✅ | ✅ | ✅ | ✅ Angular 21+ (`ng test`, Vitest runner) | ✅ pytest ≥ 7, Python ≥ 3.12 |
| ▶ Run / ▷ Debug one test or suite | ✅ | ✅ | ✅ | ✅ | ✅ by node id; Debug needs the Python Debugger extension |
| Rerun a saved test file | ✅ | ✅ | ✅ | ✅ | ✅ |
| Logs / console output | ✅ per file | ✅ per file | ✅ per test | ✅ per test | ✅ per test (stdout, stderr, logging) |
| Coverage (gutter, hover) | ✅ | ✅ | ✅ needs `@vitest/coverage-v8` (or `-istanbul`) | ✅ needs `@vitest/coverage-v8` | ✅ needs `coverage` (pytest-cov not needed) |
| Live per-file progress | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rerun tests related to a saved source file | ✅ | ✅ | ✅ only the tests that ran it (execution trace); `vitest related` when the trace is off | ✅ the test files that import it (relative imports); all of its project otherwise | ✅ only the tests that ran it (coverage contexts); importing test files before that |
| Monorepo / multi-project (project switcher) | ✅ one project per package; a root `projects` config stays one | 🟡 a CRA app is detected as a package (not e2e-tested) | ✅ one project per package; `test.projects` stays one, grouped by name | ✅ one project per workspace; its apps and libraries run with `ng test <name>`, grouped by name | ✅ one project per uv workspace member with tests; a root pytest config stays one |
| Mixed Jest + Vitest in one project | ✅ each test file runs with its own framework | — | ✅ | — | — |
| JS + Python in one folder | ✅ one project runs Jest / Vitest and pytest | 🟡 not e2e-tested | ✅ | 🟡 not e2e-tested | ✅ a `.py` save reruns pytest only, a `.js` save the JS framework only |
| Execution trace / "covering tests" | ✅ | ✅ | ✅ Vitest ≥ 3 (incl. `vitest.workspace` files); not in browser mode | ⏳ planned | ✅ from coverage.py contexts (needs `coverage`) |
| UI components (`.vue`, `.svelte`, `.astro`, `.marko`): save reruns, trace, coverage | ✅ through the project's transformer (vue-jest, svelte-jester…) | — (React is plain JS) | ✅ through the project's Vite plugins | ✅ templates (`templateUrl`) rerun their component's tests; coverage includes templates | — |
| Timeline debugger | ⏳ planned | ⏳ planned | ⏳ planned | ⏳ planned | ⏳ planned |
<!-- matrix:end -->

pytest: pytest 7.0 or newer on Python 3.12 or newer, run with the project's own
environment (its `.venv` / `venv`, poetry or pipenv env, the Python extension's
choice, or `liveTestRunner.pythonPath`; **Select Python Interpreter** picks one).
Nothing is installed into it: the extension ships its own pytest plugin and loads
it only on its own command line. Results match a plain `pytest` run test for test;
runs keep pytest's cache in the session folder (your `--lf` state is untouched),
pytest-cov stays idle in our runs (`--no-cov`; coverage is measured with the
project's own coverage.py settings), and pytest-xdist runs with `-n 0` — the
extension runs one pytest process at a time, as your terminal does, because
pytest projects share session fixtures, ports and files between tests. Covering
tests come from coverage.py's per-test contexts; before a file has any, a save
reruns the test files that import it. Python monorepos: one project per uv
workspace member with tests (3.3.0). JS + Python in one folder: one project runs
both, or a Python subfolder with its own pytest config is its own project (3.3.0).

Vitest: version 3 or newer is fully supported; 1.x and 2.x run with results
only (no test listing, related tests, trace or line numbers). Coverage uses
Vitest's own provider package. The execution trace (covering tests in the
hover, precise reruns on save) is on by default (`liveTestRunner.vitestTrace`);
it adds a Vite plugin through a wrapper config (Vitest 3 workspace files
included; type-check `*.test-d.ts` files are fine) and turns itself off for a
project it cannot reach (a broken run) — saves then use `vitest related`.
Browser-mode projects (opt-in) run without it.

UI frameworks: any. React, Preact, Solid, Lit, Angular and Qwik code is plain
JS / TS; single-file components (Vue, Svelte, Astro, Marko) are compiled by the
project's own Jest transformer or Vite plugin and mapped back to their own
lines; any other extension the Jest config loads (`moduleFileExtensions`), any
file in Vitest's module graph (HTML via `?raw`, templates a plugin reads) and
templates named by a relative path (Angular `templateUrl` under Jest) rerun
their tests on save. Type-check tests (`*.test-d.ts`) rerun with the files they
check. Jest's ESM mode (`NODE_OPTIONS=--experimental-vm-modules`
in the test script, or `node-options` in `.npmrc`) is honoured.
