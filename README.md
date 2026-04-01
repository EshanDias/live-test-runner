# Live Test Runner - Developer Guide

This is the development repository for Live Test Runner, a VS Code extension for live testing on save.

## Project Structure

This is a monorepo with the following packages:

```
packages/
├── core/           # Shared business logic (TestSession, CoverageMap, etc.)
├── runner/         # Test runner abstractions (JestRunner, etc.)
└── vscode-extension/ # The VS Code extension itself
```

## Architecture

- **Session-based**: Testing only active during explicit sessions
- **Framework abstraction**: TestRunner interface allows adding new frameworks
- **Coverage-assisted mapping**: Uses Jest coverage to map source files to tests
- **VS Code Testing API**: Integrates with Test Explorer

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build all packages: `npm run build`
4. Open in VS Code
5. Press F5 to launch extension development host

## Building

```bash
# Build all packages
npm run build

# Build individual packages
cd packages/core && npm run build
cd packages/runner && npm run build
cd packages/vscode-extension && npm run compile
```

## Testing

```bash
# Run tests for all packages
npm test

# Run extension tests
cd packages/vscode-extension && npm test
```

## Adding a New Test Framework

1. Implement `TestRunner` interface in `packages/runner/src/`
2. Export from `packages/runner/src/index.ts`
3. Add configuration option in extension for framework selection
4. Update extension to instantiate the appropriate runner

Example for Vite:

```typescript
// packages/runner/src/ViteRunner.ts
export class ViteRunner implements TestRunner {
  // Implement interface methods
}
```

## VS Code Extension Development

### Key Files

- `packages/vscode-extension/src/extension.ts`: Main extension entry point
- `packages/vscode-extension/package.json`: Extension manifest and configuration

### Debugging

- Press F5 in VS Code to launch Extension Development Host
- Set breakpoints in extension code
- Test commands via Command Palette

### Publishing

1. Update version in `packages/vscode-extension/package.json`
2. Build: `npm run build`
3. Package: `vsce package`
4. Publish: `vsce publish`

## Configuration Schema

Settings are defined in `packages/vscode-extension/package.json` under `contributes.configuration.properties`.

## Test Explorer Integration

Uses VS Code's Testing API:
- `vscode.tests.createTestController()` creates the controller
- `refreshHandler` populates test items
- `runHandler` executes tests

## Performance Considerations

- Jest runs in child processes, never in extension host
- Coverage parsing is done asynchronously
- On-save execution is debounced
- Processes are killed on session end

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prettier for formatting (if configured)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Add tests
5. Submit a pull request

### Commit Messages

Follow conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation
- `refactor:` for code changes

## Roadmap

- [ ] Vite test runner
- [ ] Playwright test runner
- [ ] Suite/test-case level Test Explorer items
- [ ] Inline diagnostics and squiggles
- [ ] Time-travel debugging integration

## License

MIT