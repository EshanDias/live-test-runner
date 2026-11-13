# Test runs

**In one line:** Start runs the whole suite in parallel batches that fit your machine, streams each file's result as soon as it is done, survives hanging and crashing tests, and Stop ends everything at once.

| | |
|---|---|
| **Who it is for** | Everyone. This is what happens under every other feature |
| **Frameworks** | Jest (including Create React App), Vitest, Angular (Vitest through `ng test`), pytest |
| **Requirements** | [Test runs: requirements](../requirements/test-runs.md) |
| **How it is built** | [Test runs: design](../development/design/test-runs.md) |

---

## The problem

A full test run can take minutes, use every core, and give you nothing until it ends. One hanging test can block it forever, and one broken file can make the whole run report nothing.

## What Live Test Runner does

- **Your files first.** The test files open in your editor run first. A test file you open while the run is going moves to the front of the queue. On the first Start of a large project, your open files start while the framework is still listing which files it runs (that can take half a minute); if the list then leaves one of them out, its results are taken back and it shows as not run.
- **Results stream in.** Each file's result appears when that file finishes, not when the run ends. A file only shows ⟳ once the framework actually starts it.
- **Batches that fit your machine.** Files are grouped into batches that run in parallel. The `speed` setting is where runs start: **Balanced** (the default) about half the CPU cores, **Full** about three quarters, **Light** one test process with at most 2 workers. Runs then adapt: when your other apps leave the cores free they use more (up to Full, and no more than your physical cores), when your apps need them they back off (down to Light). Turn on `speedStrict` to keep runs exactly at the level. Vitest's workers are capped to fit; a lower `maxWorkers` in your config is kept. pytest runs one process at a time, as in your terminal, so session fixtures and fixed ports keep working; a suite your project already runs in parallel (pytest-xdist's `-n` in its own pytest options) runs in several processes.
- **Your work comes first.** Test processes run at a lower priority than your editor and other apps: on an idle machine they run as fast as before, and when you type or use another app, it gets the CPU first. When the machine runs short of memory, the next batch waits for one to finish rather than pushing the machine into swap.
- **Hanging tests are stopped.** A test that runs longer than `hangTimeoutSeconds` (5 minutes by default), such as an infinite loop, is stopped and its file marked failed. The rest of the run carries on.
- **Crashes are contained.** If a batch dies, the files that got no result are retried in smaller batches, then on their own with a plain framework run. The log says so.
- **Stop means stop.** Every framework process and its children end. Nothing retries, and nothing spins.
- **Same results as your terminal.** Your config, setup files, test-script flags and plugins apply. The extension runs your project's own Jest, Vitest, Angular or pytest.

### What is written, and where

Nothing goes into your project. Everything lives in your user cache and temp folders: each window's session folder (deleted when the window closes), the list of runnable files, compiled-file caches and coverage maps. Data no window has used for 30 days is deleted when VS Code starts.

### Example

You click Start on a project with 200 test files on an 8-core machine. Two batches run at once. `cart.test.ts`, open in your editor, runs first and shows its result within seconds. A test with an accidental `while (true)` is stopped after 5 minutes and its file shows the reason. The other 199 files finish normally.

## What you can change

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.speed` | `balanced` | Where runs start: `full`, `balanced` or `light`. Applies from the next run |
| `liveTestRunner.speedStrict` | `false` | Keep runs at the `speed` level exactly instead of adapting to how busy the machine is |
| `liveTestRunner.hangTimeoutSeconds` | `300` | Stop a single test that runs longer than this. `0` turns the limit off |
| `liveTestRunner.jestCommand` / `vitestCommand` | `""` | Use another command instead of the project's own Jest or Vitest |
| `liveTestRunner.runMode` | `auto` | `npm`: run Jest through `npm test --` |
| `liveTestRunner.pytestArgs` | `[]` | Extra pytest arguments for every run, such as `["-m", "not slow"]` |
| `liveTestRunner.vitestIncludeBrowserProjects` | `false` | Also run Vitest browser-mode projects (they need real browsers) |

## Good to know

- **Stop Testing and Clear Cache** (Shift-click Stop) also deletes the project's cached data. **Clear Cache and Restart Testing** then runs everything again.
- **Copy Diagnostic Report** copies versions, project setup and recent log lines for a bug report.
- Under Live Test Runner, Jest's `testTimeout` is raised to at least 30 seconds to absorb the measuring overhead.

## Related

- [User guide: Logs & troubleshooting](https://eshandias.github.io/live-test-runner/guide/#logs)
- [Project-wide requirements](../requirements/project-rules.md): the resource budget and "never touch the project" rules
