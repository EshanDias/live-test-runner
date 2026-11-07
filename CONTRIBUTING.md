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
- Update `CHANGELOG.md` (full detail) and `packages/vscode-extension/CHANGELOG.md` (short, user-facing) for anything users notice.
- Update the docs in the same pull request (see [Documentation](#documentation) below).
- Add or update tests: unit tests next to the package, and an e2e scenario (`e2e/scenarios/`) for behaviour in the editor.

Merging a `release/*` branch into `main` builds, tests and publishes the extension; tags and GitHub Releases are created by the pipeline, never by hand.

## Documentation

Each feature has three pages: what it does (`docs/features/`), what it must do and which tests check it (`docs/requirements/`), and how it is built (`docs/development/design/`). They are listed in [docs/README.md](docs/README.md) and copied to the [Wiki](https://github.com/EshanDias/live-test-runner/wiki), which is never edited directly.

A pull request that changes behaviour updates its docs too:

| You change… | Update |
|---|---|
| What users see a feature do (behaviour, UI, a limit) | `docs/features/<feature>.md`, the user guide (`docs/live-test-runner-guide.html`), both changelogs |
| What a feature must do, or a test that checks it | `docs/requirements/<feature>.md`: add or edit the row; when you add a test for a ⚠️ row, name it and drop the ⚠️ |
| How a feature is built (key files, flow, a design decision) | `docs/development/design/<feature>.md`; `docs/development/architecture.md` when the big picture changes |
| A setting or command | The feature page's settings table, the guide's settings or commands table, `packages/vscode-extension/README.md` |
| A project-wide rule | `docs/requirements/project-rules.md` and `CLAUDE.md` |
| A new feature | All three pages (copy an existing set as the template), and list them in `docs/README.md` |
| A removed feature | Delete its pages and every link to them |

Run `node scripts/build-wiki.js --check` before pushing. It fails on a broken docs link.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
