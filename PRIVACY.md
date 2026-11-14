# Privacy policy

_Last updated: 2026-11-14 (your AI assistant can read results and run tests; see [Your AI assistant](#your-ai-assistant)). Applies to Live Test Runner 3.5.0 and later._

**In short:** Live Test Runner collects nothing and sends nothing. It runs your own test framework on your machine, and everything it keeps stays on your machine.

## What the extension does with your code

- **Reads** your project's files to find tests, and the results your test framework (Jest, Vitest, Angular, pytest) reports.
- **Runs** your own test framework, from your project, in child processes on your machine.
- **Checks how busy your machine is** (CPU load, free memory, the CPU and memory of its own test processes, the number of CPU cores) to decide how many tests run at once. These numbers are used at that moment and are never stored.
- **Never changes** your project: it installs nothing into it and edits none of its code, config or files. The one exception is **Update snapshot**, which you click on a failed snapshot test. A dialog first names the file that will change and asks you to confirm. Then your test framework (Jest or Vitest) rewrites that test's snapshot, as `jest -u` would for that one test. Like `jest -u`, it also removes snapshots in that file that no test uses any more.

## What it keeps, and where

| What | Where | How to remove it |
|---|---|---|
| Test lists, test results, coverage and traces of the current session | Your system's temp folder, `com.eshLabs/live-test-runner/` | Removed once its VS Code window is closed (at the latest when VS Code next starts); **Clear All Cached Data** removes everything |
| A cache that makes the next start faster (test lists, Jest's transform cache, what your Vitest config resolves to: project names, coverage include / exclude patterns, worker limit) | Your system's cache and temp folders, `com.eshLabs/live-test-runner/` | **Clear All Cached Data**; anything unused for 30 days is deleted automatically |
| The Python interpreter you picked for a project | VS Code's workspace storage | **Select Python Interpreter** again, or remove the workspace's storage |
| For your AI assistant: a note saying which folders this window has open (`bridge.json`), and each question and answer while it is being passed on (deleted as soon as it is read) | The window's session folder in your temp folder | Removed with the session folder when the window closes |
| For AI assistants outside the editor: a small start script (`mcp/live-test-runner-mcp.js`), where the installed extension is, and one note per open window saying which folders it has open | The extension's own storage folder in VS Code | Each window's note is removed when it closes; uninstalling the extension removes the folder |

Nothing is kept anywhere else.

## What it never does

- **No network calls.** The extension talks to nothing outside your machine. Its views load nothing from the internet; the built-in guide's pictures are links you can click.
- **No telemetry.** No usage statistics, analytics or crash reports.
- **No accounts.** No sign-in, no licence server.
- **No AI services.** The extension calls no AI model or AI service.

## When you share something yourself

Some actions hand data over only because you asked:

- **Copy buttons** (an error, output, a diagnostic report, failing test names, and **Copy for AI**, which includes your test's code and the lines it failed in) put text on your clipboard. Where it goes next is your choice. Check it for anything private before you paste it somewhere.
- **Links** (the online guide, GitHub, the marketplace) open in your browser only when you click them.
- **Fix with AI** (on a failing test) opens your AI assistant's chat with a request to fix that test, or copies the failure to your clipboard where no chat can be opened.

## Your AI assistant

Live Test Runner gives the AI assistant you use (GitHub Copilot, Cursor, Claude Code, Codex, Gemini CLI and others) tools to read your live test results and run tests while it works. This is on by default; the setting `liveTestRunner.ai.bridge` turns it off.

- **What your assistant can read:** test names and results, error messages, console output, coverage, and lines of your tests and source code, the same as **Copy for AI**.
- **When:** only when your assistant asks, and only that assistant. Assistants ask you before they use a tool (each has its own setting for this).
- **Who can ask:** in VS Code, Copilot finds the tools without setup, and so does Cursor's agent in Cursor. An assistant outside the editor (Claude Code, Codex, Gemini CLI…) can ask only after you add Live Test Runner to it yourself, with the command on the **Connect Your AI Assistant** page. The extension never changes other programs' settings.
- **What it can do:** run tests, the same as clicking ▶ Run, and **Clear Cache and Restart** while testing is on. It can never start or stop testing; that stays with you. To let it only read, set `liveTestRunner.ai.allowRuns` to `never` (or `ask` to confirm each run). Updating a snapshot still needs your yes in the usual dialog.
- **How it gets there:** inside the editor through VS Code's language-model tools; to assistants outside the editor through a small program that the assistant starts on your computer and that passes questions and answers through files in the window's session folder. The extension makes no network call and opens no network port.
- **What happens next:** your assistant sends what it read to its own AI service, under that service's privacy policy. Test output can contain anything your tests print, so leave the feature off for projects whose test output must not leave your machine.

## What else may use the network

Your own tests, your test framework and VS Code itself may use the network. That is outside the extension: it runs them as they are.

## How to check

The extension is open source under the MIT license. Every pull request runs [`noNetwork.test.ts`](packages/vscode-extension/test/noNetwork.test.ts) (part of `pnpm test`). The test scans the source and the built extension for:

- network modules and network APIs
- telemetry, error-reporting and AI-service packages
- any view that could load something from another origin

## Changes and questions

Changes to this policy are listed in the [changelog](CHANGELOG.md). Questions: open an [issue](https://github.com/EshanDias/live-test-runner/issues). Security problems: see [SECURITY.md](SECURITY.md).
