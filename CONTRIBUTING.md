# Contributing to Live Test Runner

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and requesting features

- **Bugs:** [open a bug report](https://github.com/EshanDias/live-test-runner/issues/new?template=bug_report.yml). The form asks for the versions, your framework and the extension log — that is usually enough to reproduce the problem.
- **Ideas:** [request a feature](https://github.com/EshanDias/live-test-runner/issues/new?template=feature_request.yml). Describe the problem first; the solution can be worked out together.
- **Security problems:** please report them privately — see [SECURITY.md](SECURITY.md).

Before opening a new issue, search the [existing ones](https://github.com/EshanDias/live-test-runner/issues) — adding a 👍 or a comment to an existing issue helps prioritise it.

## Development setup

```bash
pnpm install        # pnpm version pinned via packageManager
pnpm start          # TypeScript watch mode; press F5 in VS Code for the Extension Development Host
pnpm test           # unit tests
pnpm lint
node e2e/run.js --all   # end-to-end: real VS Code + real Jest / Vitest / pytest (build first)
```

The [documentation](docs/README.md) has three kinds of pages: what each feature does, what it must do (requirements), and how it is built. The [developer documentation](docs/development/README.md) explains the architecture, how to add a framework, and how the end-to-end tests work. The [Wiki](https://github.com/EshanDias/live-test-runner/wiki) is a copy of `docs/`: to change a page, edit its file in `docs/` in a pull request.

## Ground rules for changes

These keep the extension safe to install in anyone's project:

- **Never touch the user's project.** No installs into it, no edits to its code, config or files. Anything the extension needs ships inside it; anything it writes goes to its own temp or cache folder.
- **Zero configuration.** Install, click Start — detection must work without settings.
- **Never overuse the machine.** All parallelism (batches, frameworks, projects) stays within one budget based on free cores and memory.
- **Dependency direction:** `vscode-extension` → `core` → `runner`. `runner` and `core` never depend on VS Code.
- **Spawn, never exec** child processes; log through the logger, never `console.*`.

## Branches and pull requests

| Branch | Purpose | Targets |
|---|---|---|
| `feat/*` | New features | a `release/*` branch (or the `feat/*` it was branched from) |
| `bugfix/*` | Bug fixes | the `feat/*` or `release/*` it was branched from |
| `hotfix/*` | Urgent fixes | `main` or a `release/*` |
| `release/<version>` | One release's changes | `main` |

- Work happens on a branch; `main` and `release/*` only change through pull requests.
- PRs must pass the checks (`pnpm test`; PRs to `main` also need a version bump).
- Update `CHANGELOG.md` (full detail) and `packages/vscode-extension/CHANGELOG.md` (short, user-facing) for anything users notice, and the docs where behaviour changes (for a feature: its pages in `docs/features/`, `docs/requirements/` and `docs/development/design/`).
- Add or update tests: unit tests next to the package, and an e2e scenario (`e2e/scenarios/`) for behaviour in the editor.

Merging a `release/*` branch into `main` builds, tests and publishes the extension; tags and GitHub Releases are created by the pipeline, never by hand.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
