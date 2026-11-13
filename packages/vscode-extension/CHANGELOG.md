# Changelog

## [3.4.1] - Unreleased

- New **Speed** setting (`liveTestRunner.speed`): tests use what your machine has free, and your editor stays responsive.
- Much faster on big projects: Jest about 2×, Angular about 7×, pytest about 10×, Vitest about 20%.
- Coverage now matches your own coverage command, and stays right as you add, change or delete tests.
- Jest tests that use fake timers are no longer stopped as hanging.

## [3.4.0] - 2026-11-09

- **Angular** support (Angular 21+): results, coverage, Debug.
- Failures show on the failing line; hover for the full message and diff.
- **Update snapshot** from a failure, after asking you first.
- **Copy for AI**: copy a failure with its test code for your AI assistant.
- Vitest no longer maxes out your CPU.

## [3.3.0] - 2026-11-07

- **Python monorepos** and **JS + Python in one folder**: each part runs with its own framework.
- Open test files run first when you Start.
- The Coverage tab tells you when coverage is off and what to install.

## [3.2.1] - 2026-11-05

- Changes from outside the editor (`git pull`, branch switch) rerun tests like a save.
- Coverage bars moved to the line edge; hide them with the eye button.
- **Stop** now stops everything.

## [3.2.0] - 2026-10-30

- **pytest** support: results, coverage, Run / Debug, reruns on save.
- A live **Running** count while tests run.

## [3.1.0] - 2026-10-28

- **Monorepos**: every package with tests is its own project, with a project switcher.
- **Vitest**: covering tests in the hover and precise reruns on save.
- Jest and Vitest in one project; Vue, Svelte and other compiled files supported.

## [3.0.0] - 2026-10-22

- **Vitest** support (preview): results, coverage, Run / Debug.
- Coverage totals match `jest --coverage` / `vitest --coverage`.
- New website and in-editor guide.

## [2.0.4] - 2026-10-19

- Hanging tests are stopped and marked failed.
- **Copy Diagnostic Report** for bug reports.
- Many fixes for Windows, TypeScript configs and missing results.

## [2.0.3] - 2026-05-15

- Fixed tests that use optional chaining (`?.()`).

## [2.0.2] - 2026-05-01

- Fixed coverage on Windows.

## [2.0.1] - 2026-04-23

- Fixed Create React App projects (react-scripts 4) staying "pending".

## [2.0.0] - 2026-04-21

- **Code coverage**: totals, coloured line bars, and the tests covering each line on hover.

## [1.4.0] - 2026-04-19

- Much faster restarts and runs on large projects; results stream in per file.

## [1.3.0] - 2026-04-14

- Parameterized tests (`test.each`) shown as groups.
- Several VS Code windows no longer interfere.

## [1.2.0] - 2026-04-14

- Unlimited `describe` nesting; large trees stay fast.

## [1.1.1] - 2026-04-13

- Fixed tests not running on large projects and on Windows.

## [1.1.0] - 2026-04-12

- The test tree appears before you Start; run one test with ▶ Run.
- Saving a file reruns only the tests that use it.

## [1.0.0] - 2026-04-09

- Gutter icons, inline durations and Run / Debug / Results above each test.

## [0.2.0] - 2026-04-04

- Test Explorer and Results panel.

## [0.1.0] - 2026-04-03

- Initial release: Jest tests run on save, results in VS Code.
