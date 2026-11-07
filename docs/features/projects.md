# Monorepos and mixed frameworks

**In one line:** each test project in the window is found on its own (packages of a monorepo, folders of a multi-root workspace, Python services), and a project that uses two frameworks runs each test file with the right one.

| | |
|---|---|
| **Who it is for** | Teams with several packages or services, or a project moving from Jest to Vitest, or a JS front end next to Python |
| **Frameworks** | Jest, Vitest and pytest, in any combination |
| **Requirements** | [Monorepos and mixed frameworks: requirements](../requirements/projects.md) |
| **How it is built** | [Monorepos and mixed frameworks: design](../development/design/projects.md) |

---

## The problem

Real repositories are rarely one project with one framework. A monorepo has a package per team, each with its own config. A migration leaves Jest and Vitest side by side. A front end lives next to a Python API. Most test tools assume one root and one framework.

## What Live Test Runner does

### Finding projects

When you open the window, every test project is detected. None runs until you start it.

| Your layout | Projects |
|---|---|
| A folder with its own test config (`jest.config.*`, `vitest.config.*`, `package.json#jest`, Create React App) | One project; its config already covers its packages |
| A monorepo root (`pnpm-workspace.yaml`, `package.json#workspaces`) without a test config | One project per package that has tests |
| A folder that configures pytest (`pytest.ini`, `[tool.pytest.ini_options]`, a root `conftest.py`…) | One project |
| A uv workspace without a pytest config at its root | One project per member that has tests, each using the workspace's shared `.venv` |
| Python services side by side, each with its own `.venv` | One project per service, each with its own environment |
| A JS folder with a Python subfolder that configures pytest (`backend/`) | Two projects |
| A multi-root workspace | Each folder by the rules above |

### Working with several projects

- **The project switcher** at the top of the sidebar (`web ▾ ● running ✓120 ✗2`) picks which project the tree, Results panel and status bar show.
- **The editor always shows a file's own project.** Open a file from another package and you see its results, and `▶ Run` runs it there.
- **Start and Stop act on the project shown.** Others keep running, and rerunning on save, in the background.
- **How many run at once:** 2 by default, or 1 on smaller machines (4 cores or fewer, or under 8 GB of memory). Starting one more asks you to stop one first.

### Two frameworks in one project

A project with a Jest config and its own `vitest.config.*` (a migration in progress) runs each test file with exactly one framework, chosen in this order:

1. The `liveTestRunner.frameworks` setting, for example `{ "packages/new/**": "vitest" }`.
2. The configs: if only one framework's config lists the file, that one.
3. The file: an import from `vitest` or a `vi.` call means Vitest; `@jest/globals` or a `jest.` call means Jest.
4. Otherwise the main framework (Jest), with one log line naming the setting.

A JS project that also configures pytest runs `.py` tests with pytest and the rest with Jest or Vitest. The sidebar groups files by framework, and the status bar splits the counts (`Jest 12 · pytest 30`).

### Example

A pnpm monorepo has `web` (Vitest), `api` (Jest) and `services/billing` (pytest). The switcher lists three projects. You start `web` and `billing`. Saving a file in `web` reruns `web`'s tests only, and `billing` is untouched.

## What you can change

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.maxRunningProjects` | `auto` | How many projects can run at once (a number, or `auto`) |
| `liveTestRunner.projectRoot` | `""` | Pin the window to one folder (also **Select Project Root**) |
| `liveTestRunner.frameworks` | `{}` | Glob → `"jest"` / `"vitest"`: which framework runs those test files |
| `liveTestRunner.pythonPath` | `""` | The Python that runs pytest. Empty: the one you picked, else the project's own environment |

## Good to know

- A `vitest` dependency or a `vite.config.*` alone doesn't make a Jest project mixed. It needs a Vitest config of its own, or the setting.
- The Python environment is found without activating anything: the project's `.venv` / `venv`, its poetry or pipenv environment, or the Python extension's choice. A chip under Start shows which one runs, and clicking it picks another.

## Related

- [User guide: Monorepos](https://eshandias.github.io/live-test-runner/guide/#monorepos) · [Jest, Vitest and pytest in one project](https://eshandias.github.io/live-test-runner/guide/#mixed)
