## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How it was tested

- [ ] `pnpm test` passes
- [ ] End-to-end scenarios for the affected area (`node e2e/run.js <scenario>`), or a new one
- [ ] Tried in the Extension Development Host (F5) on a real project

## Checklist

- [ ] Branch name starts with `feat/`, `bugfix/`, `hotfix/` or `release/`, and targets the right branch (see [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] `CHANGELOG.md` (short bullets) and `packages/vscode-extension/CHANGELOG.md` (short, user-facing) updated for user-visible changes
- [ ] Docs updated in this PR where behaviour changed: the feature's pages in `docs/features/`, `docs/requirements/` (new tests named, ⚠️ dropped) and `docs/development/design/`, the user guide, the README (see [Documentation](../CONTRIBUTING.md#documentation))
- [ ] `node scripts/build-wiki.js --check` passes
- [ ] No network calls or telemetry added; anything new the extension stores or shares is in [PRIVACY.md](../PRIVACY.md)
