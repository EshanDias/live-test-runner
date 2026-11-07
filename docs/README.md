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

- [On-save reruns](features/on-save-reruns.md): save a file, only the affected tests run

## Requirements

What the extension must do, each requirement linked to the tests that check it.

- [Project-wide requirements](requirements/project-rules.md): rules every feature follows (zero config, never touch the user's project, the resource budget…)
- [On-save reruns](requirements/on-save-reruns.md)

## Development

How the code is organised and how to work on it.

- [Developer guide](development/developer-guide.md): setup, build, logging, adding a framework, tests, releases
- [Architecture](development/architecture.md): packages, data model, execution flow, key decisions
- Feature designs:
  - [On-save reruns](development/design/on-save-reruns.md)
- [Framework feature matrix](development/framework-features.md): what each framework supports
- [AI context](development/ai-context.md): a dense summary of the codebase for AI coding assistants

## Contributing

- Report a bug or ask for a feature on [GitHub Issues](https://github.com/EshanDias/live-test-runner/issues)
- [Contributing guide](../CONTRIBUTING.md) · [Security policy](../SECURITY.md) · [Changelog](../CHANGELOG.md)

These pages are kept in the repository under `docs/` and copied to the [Wiki](https://github.com/EshanDias/live-test-runner/wiki) on every release. To change a page, open a pull request that edits the file in `docs/`.
