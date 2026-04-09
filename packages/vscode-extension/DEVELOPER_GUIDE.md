# Developer Guide — VS Code Extension

Full documentation is in the root-level docs:

| Document | Content |
|----------|---------|
| [architecture.md](../../docs/architecture.md) | System design, VS Code layout, panels, decorations, data model, execution flow |
| [developer-guide.md](../../docs/developer-guide.md) | Setup, patterns, practices, adding frameworks, publishing |
| [ai-context.md](../../docs/ai-context.md) | Complete codebase context for AI assistants |

---

## Extension source layout

```
src/
├── extension.ts                    Entry point — wires instances, registers commands (~110 lines)
├── IResultObserver.ts              Interface all result consumers implement
├── store/
│   ├── ResultStore.ts              In-memory File→Suite→Test tree + LineMap + ScopedOutput
│   └── SelectionState.ts           Selected row tracking
├── session/
│   └── SessionManager.ts           Session lifecycle, run pool, on-save, rerun
├── framework/
│   ├── IFrameworkAdapter.ts        Adapter interface
│   └── JestAdapter.ts              Jest-specific logic
├── editor/
│   ├── CodeLensProvider.ts         ▶ Run / ▷ Debug / ◈ Results
│   └── DecorationManager.ts        Gutter icons + inline durations
├── utils/
│   └── duration.ts                 Threshold logic shared with webviews
├── views/
│   ├── BaseWebviewProvider.ts      Webview base class
│   ├── ExplorerView.ts             Sidebar tree
│   └── ResultsView.ts              3-column results panel
└── webview/                        Browser-side assets (not compiled by tsc)
    ├── explorer.html
    ├── results.html
    ├── testListLayout.js           Shared test list renderer
    ├── utils.js                    JS mirror of duration.ts
    └── styles.css
```

## Build

```bash
pnpm run compile   # single build
pnpm start         # watch mode
```

## Publish

```bash
pnpm run build
vsce package
vsce publish
```
