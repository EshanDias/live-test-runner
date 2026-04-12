# Live Test Runner

A VS Code extension that runs Jest tests automatically on file save, showing results directly in the editor. No terminal switching, no manual commands — instant feedback as you write code.

---

## What it does

- **Static test discovery** — the full test tree (file → suite → test) appears in the sidebar the moment you open a project, before running anything. Line numbers, pending icons, and Run/Debug CodeLens buttons are live immediately.
- **Smart on-save execution** — save any file and only the affected tests run automatically. After the first full run, source file saves rerun individual test cases (not whole files) based on the execution trace
- **Custom test explorer** — live status icons, duration badges, search, and per-row rerun buttons
- **Results panel** — three-column view: test list, console output, and error details
- **Editor decorations** — gutter icons and inline durations on every test line
- **CodeLens buttons** — `▶ Run`, `▷ Debug`, and `◈ Results` above every `it()` and `describe()` — available from project load, not just after a run
- **Smart detection** — works with standard Jest and Create React App out of the box
- **Test Timeline Debugger** — step-by-step replay of any test case with variable inspection, inline values, and call stack (see [extension README](packages/vscode-extension/README.md))

---

## Packages

| Package | Name | Purpose |
|---------|------|---------|
| `packages/core` | `@live-test-runner/core` | Session lifecycle + coverage map |
| `packages/runner` | `@live-test-runner/runner` | Framework-agnostic test execution engine |
| `packages/vscode-extension` | `live-test-runner` | VS Code extension |

---

## Documentation

| File | What it covers |
|------|---------------|
| [docs/architecture.md](docs/architecture.md) | Full system design — VS Code layout, packages, data model, execution flow, UI details, key decisions |
| [docs/developer-guide.md](docs/developer-guide.md) | Dev setup, patterns and practices, adding frameworks, publishing |
| [docs/ai-context.md](docs/ai-context.md) | Complete AI context — paste into any conversation for full codebase understanding |
| [packages/core/README.md](packages/core/README.md) | Core package API and design |
| [packages/runner/README.md](packages/runner/README.md) | Runner package API, layers, CRA behavior |
| [packages/vscode-extension/README.md](packages/vscode-extension/README.md) | User guide — features, commands, configuration |

---

## Quick start (development)

```bash
pnpm install
pnpm start          # TypeScript watch mode
# Press F5 in VS Code to launch the Extension Development Host
```

See [docs/developer-guide.md](docs/developer-guide.md) for full setup and build instructions.

---

## License

MIT
