# Live Test Runner documentation

Live Test Runner is a VS Code extension that reruns the tests affected by each save and shows the results in the editor, for Jest, Vitest and pytest.

The docs come in three kinds. Pick the one for your question:

| I want to know… | Read |
|---|---|
| **What a feature does**, in plain language | [Features](#features) |
| **What a feature must do**, and how that is checked | [Requirements](#requirements) |
| **How it is built**, to change or fix it | [Development](#development) |
| **How to use it** day to day | The [user guide](https://eshandias.github.io/live-test-runner/guide/) |

## Features

What each feature is for, how it behaves, and its limits. No code knowledge needed.

- [Test runs](features/test-runs.md): Start, batches that fit your machine, hanging tests, Stop
- [Test Explorer and editor](features/test-explorer.md): every test listed before it runs; icons, durations, `▶ Run` in the editor
- [On-save reruns](features/on-save-reruns.md): save a file, only the affected tests run
- [Results panel](features/results-panel.md): results, console output and failures per test
- [Coverage](features/coverage.md): bars on every line, and the tests that ran it
- [Debugging](features/debugging.md): `▷ Debug` one test with breakpoints
- [Monorepos and mixed frameworks](features/projects.md): many projects in one window, Jest + Vitest + pytest side by side

## Requirements

What the extension must do, each requirement linked to the tests that check it.

- [Project-wide requirements](requirements/project-rules.md): rules every feature follows (zero config, never touch the user's project, the resource budget…)
- [Test runs](requirements/test-runs.md) · [Test Explorer and editor](requirements/test-explorer.md) · [On-save reruns](requirements/on-save-reruns.md) · [Results panel](requirements/results-panel.md) · [Coverage](requirements/coverage.md) · [Debugging](requirements/debugging.md) · [Monorepos and mixed frameworks](requirements/projects.md)

Requirements marked ⚠️ have no automated test yet.

## Development

How the code is organised and how to work on it.

- [Developer guide](development/developer-guide.md): setup, build, logging, adding a framework, tests, releases
- [Architecture](development/architecture.md): packages, data model, execution flow, key decisions
- Feature designs:
  - [Test runs](development/design/test-runs.md) · [Test Explorer and editor](development/design/test-explorer.md) · [On-save reruns](development/design/on-save-reruns.md) · [Results panel](development/design/results-panel.md) · [Coverage](development/design/coverage.md) · [Debugging](development/design/debugging.md) · [Monorepos and mixed frameworks](development/design/projects.md)
- [Framework feature matrix](development/framework-features.md): what each framework supports
- [AI context](development/ai-context.md): a dense summary of the codebase for AI coding assistants

## Keeping these docs current

The docs describe the code as it is. A change isn't finished until its docs match it, in the same pull request:

| You change… | Update |
|---|---|
| What users see a feature do (behaviour, UI, a limit) | `docs/features/<feature>.md`, the user guide (`docs/live-test-runner-guide.html`), both changelogs |
| What a feature must do, or a test that checks it | `docs/requirements/<feature>.md`: add or edit the row; when you add a test for a ⚠️ row, name it and drop the ⚠️ |
| How a feature is built (key files, flow, a design decision) | `docs/development/design/<feature>.md`; `docs/development/architecture.md` when the big picture changes |
| A setting or command | The feature page's settings table, the guide's settings or commands table, `packages/vscode-extension/README.md` |
| A project-wide rule | `docs/requirements/project-rules.md` and `CLAUDE.md` |
| A new feature | All three pages (copy an existing set as the template), and list them in `docs/README.md` |
| A removed feature | Delete its pages and every link to them |

Before opening the pull request, run `node scripts/build-wiki.js --check`. It fails on a broken link, and the PR checks run it too.

## Contributing

- Report a bug or ask for a feature on [GitHub Issues](https://github.com/EshanDias/live-test-runner/issues)
- [Contributing guide](../CONTRIBUTING.md) · [Code of Conduct](../CODE_OF_CONDUCT.md) · [Security policy](../SECURITY.md) · [Changelog](../CHANGELOG.md)

These pages are kept in the repository under `docs/` and copied to the [Wiki](https://github.com/EshanDias/live-test-runner/wiki) on every release. To change a page, open a pull request that edits the file in `docs/`.
