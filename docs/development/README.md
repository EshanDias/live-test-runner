# Developer documentation

Everything needed to understand and change Live Test Runner without reading the code first. The full contents of the docs, including features and requirements, are in [docs/README.md](../README.md).

| Document | What it covers |
|----------|----------------|
| [developer-guide.md](developer-guide.md) | Setup, build, logging, adding a framework, unit and end-to-end tests, the real-repository matrix, releases, the website |
| [architecture.md](architecture.md) | System design: packages, VS Code layout, data model (result, trace and coverage stores), execution flow, instrumentation protocol, editor decorations, views, key design decisions |
| [design/](design/) | One page per feature: how it is built, its key files, its design decisions: [test runs](design/test-runs.md), [Test Explorer and editor](design/test-explorer.md), [on-save reruns](design/on-save-reruns.md), [Results panel](design/results-panel.md), [coverage](design/coverage.md), [debugging](design/debugging.md), [monorepos and mixed frameworks](design/projects.md) |
| [framework-features.md](framework-features.md) | What each framework supports (the matrix the README and guide are generated from: `node scripts/framework-matrix.js`) |
| [ai-context.md](ai-context.md) | A dense summary of the whole codebase for AI coding assistants (see also [CLAUDE.md](../../CLAUDE.md)) |

Package-level READMEs: [runner](../../packages/runner/README.md) · [core](../../packages/core/README.md) · [extension](../../packages/vscode-extension/README.md) (the Marketplace page).

User documentation: the [user guide](../live-test-runner-guide.html) (published at the website's `/guide/`, and shown in VS Code by **Live Test Runner: Open Guide**).

New bugs and feature ideas go to [GitHub Issues](https://github.com/EshanDias/live-test-runner/issues); see [CONTRIBUTING.md](../../CONTRIBUTING.md).
