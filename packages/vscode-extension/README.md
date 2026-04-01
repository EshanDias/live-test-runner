# Live Test Runner

Live Test Runner is a VS Code extension that provides live testing on save for Jest and other testing frameworks. It runs tests automatically when you save files, giving you fast feedback during development.

## Features

- **On-save testing**: Automatically run tests when you save source or test files
- **Session-based**: Only runs when explicitly started, no background activity
- **Test Explorer integration**: View and run tests from VS Code's Test Explorer
- **Coverage-based mapping**: Uses test coverage to determine which tests to run for source file changes
- **Monorepo support**: Select different project roots for testing
- **Framework extensible**: Currently supports Jest, with plans for Vite, Playwright, etc.

## Installation

Install from the VS Code Marketplace: [Live Test Runner](https://marketplace.visualstudio.com/items?itemName=live-test-runner)

## Quick Start

1. Open your project in VS Code
2. Select the project root: `Ctrl+Shift+P` > "Live Test Runner: Select Project Root"
3. Start testing: `Ctrl+Shift+P` > "Live Test Runner: Start Testing"
4. Save a file and watch tests run automatically!

## Commands

- **Start Testing**: Begins the testing session with a full test run and coverage analysis
- **Stop Testing**: Ends the session and stops all automatic testing
- **Rebuild Test Map**: Re-runs the full suite to rebuild the coverage map
- **Refresh Tests**: Updates the Test Explorer with current test files
- **Select Project Root**: Choose the directory containing your test configuration
- **Run Related Tests**: Manually run tests related to the current file

## Configuration

Configure settings in VS Code Settings (`Ctrl+,`) under "Extensions > Live Test Runner":

- `projectRoot`: Path to your project root (set via command)
- `jestCommand`: Command to run Jest (default: "npx jest")
- `warmupOnStart`: Run full suite when starting (default: true)
- `useCoverageMap`: Build affected test map from coverage (default: true)
- `testFilePatterns`: Glob patterns for test files (default: ["**/*.test.*", "**/*.spec.*"])
- `onSaveDebounceMs`: Delay before running tests on save (default: 300)
- `showOutputOnFailure`: Show test output when tests fail (default: true)
- `enableTestExplorer`: Enable Test Explorer integration (default: true)

## Status Bar

The status bar shows the current state:
- `Live Tests: Off` - Testing not active
- `Live Tests: Starting…` - Initializing
- `Live Tests: ✅ Ready` - Active and ready
- `Live Tests: ❌ Failed` - Error during startup

Click the status bar item to access quick actions.

## How It Works

1. **Start Testing** runs your full test suite with coverage enabled
2. Coverage data builds a map of which tests cover which source files
3. When you save a test file, that file runs
4. When you save a source file, affected tests run (from the map or Jest's related tests)

## Supported Frameworks

- **Jest** (primary, fully supported)
- **Vite** (planned)
- **Playwright** (planned)

## Troubleshooting

- **Tests not running on save**: Ensure testing is started and project root is set
- **Wrong tests running**: Try "Rebuild Test Map" to refresh coverage data
- **Performance issues**: Increase `onSaveDebounceMs` or disable coverage mapping
- **Monorepo issues**: Use "Select Project Root" for each project

## Contributing

Found a bug or have a feature request? Please file an issue on [GitHub](https://github.com/your-repo/live-test-runner).

## License

MIT