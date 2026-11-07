# Monorepos and mixed frameworks: requirements

What the feature must do, and how we check it does. For the plain-language description see [Monorepos and mixed frameworks](../features/projects.md); for how it is built see [the design](../development/design/projects.md). The [project-wide requirements](project-rules.md) apply too.

## Functional requirements

### Finding projects

| # | The extension must… | Checked by |
|---|---|---|
| P1 | Treat a folder with its own test config as one project, even when it has packages | `monorepo-run`; unit: `projectDiscovery` |
| P2 | Make one project per package with tests in a monorepo root without a test config | `monorepo-select`, `mixed-monorepo`; unit: `projectDiscovery` |
| P3 | Make one project per uv workspace member with tests, each using the workspace's shared `.venv` | `pytest-monorepo` |
| P4 | Make one project per Python service with its own `.venv`, run with that environment | `pytest-venv-per-service` |
| P5 | Find a pytest project up to two levels below a JS folder (`backend/`) as its own project | `mixed-js-python-monorepo` |
| P6 | Handle each folder of a multi-root workspace by the same rules | `multi-root-js-python` |
| P7 | Start no test run when the window opens | `monorepo-select` |

### Several projects

| # | The extension must… | Checked by |
|---|---|---|
| P8 | Switch the tree, Results panel and status bar to the project picked in the switcher | `monorepo-select`, `monorepo-run` |
| P9 | Show each file's own project in the editor (icons, CodeLens, coverage) whatever is selected | `monorepo-run` |
| P10 | Keep background projects running and rerunning on save, each in its own stores | `monorepo-run`, `multi-root-js-python` |
| P11 | Stop only the project Stop was pressed for; Stop All stops every one | `monorepo-stop`, `multi-root-js-python` |
| P12 | Refuse to start more than `maxRunningProjects`, naming the running ones (`auto` = 2, or 1 with ≤ 4 cores or < 8 GB of memory) | `monorepo-select`; unit: `projectLimits` |
| P13 | Pin the window to one root with `projectRoot` / Select Project Root | `monorepo-select` |
| P14 | Group a Vitest config's files by `test.projects` name | `monorepo-run`; unit: `resultStore`, `runnableFiles` |

### Mixed frameworks

| # | The extension must… | Checked by |
|---|---|---|
| P15 | Run each test file of a Jest + Vitest project with exactly one framework, chosen by the setting, then the configs, then the file's imports, then the main framework with one warning | `mixed-full-run`; unit: `frameworkRouting`, `frameworkRouter` |
| P16 | Re-place a file when a save changes which framework it uses | `mixed-on-save` |
| P17 | Never run a batch with files of two frameworks; never apply one framework's result to the other's file | `mixed-full-run`, `mixed-on-save` |
| P18 | Run `.py` tests of a JS + pytest folder with pytest only and the rest with the JS framework; a `.py` save reruns pytest only | `mixed-js-python` |
| P19 | Without a usable Python, still run the JS tests and say why the Python ones don't run | `mixed-js-python` |
| P20 | Stop every framework's processes on Stop | `mixed-stop`, `mixed-js-python` |

## Out of scope

- Splitting a folder whose own config already runs its packages (Jest `projects`, Vitest `test.projects`). It stays one project, or tests would run twice.
