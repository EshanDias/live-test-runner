# Privacy policy

_Last updated: 2026-11-09. Applies to Live Test Runner 3.4.0 and later._

**In short:** Live Test Runner collects nothing and sends nothing. It runs your own test framework on your machine, and everything it keeps stays on your machine.

## What the extension does with your code

- **Reads** your project's files to find tests, and the results your test framework (Jest, Vitest, pytest) reports.
- **Runs** your own test framework, from your project, in child processes on your machine.
- **Never changes** your project: it installs nothing into it and edits none of its code, config or files.

## What it keeps, and where

| What | Where | How to remove it |
|---|---|---|
| Test lists, test results, coverage and traces of the current session | Your system's temp folder, `com.eshLabs/live-test-runner/` | Removed once its VS Code window is closed (at the latest when VS Code next starts); **Clear All Cached Data** removes everything |
| A cache that makes the next start faster (test lists, Jest's transform cache) | Your system's cache and temp folders, `com.eshLabs/live-test-runner/` | **Clear All Cached Data**; anything unused for 30 days is deleted automatically |
| The Python interpreter you picked for a project | VS Code's workspace storage | **Select Python Interpreter** again, or remove the workspace's storage |

Nothing is kept anywhere else.

## What it never does

- **No network calls.** The extension talks to nothing outside your machine. Its views load nothing from the internet; the built-in guide's pictures are links you can click.
- **No telemetry.** No usage statistics, analytics or crash reports.
- **No accounts.** No sign-in, no licence server.
- **No AI services.** The extension calls no AI model or AI service.

## When you share something yourself

Some actions hand data over only because you asked:

- **Copy buttons** (an error, output, a diagnostic report, and later **Copy for AI**) put text on your clipboard. Where it goes next is your choice. Check it for anything private before you paste it somewhere.
- **Links** (the online guide, GitHub, the marketplace) open in your browser only when you click them.
- **Planned: tools for your AI assistant.** Live Test Runner may offer its results (failing tests, output, coverage) to an AI assistant you already use in VS Code, such as Copilot through VS Code's language-model tools, or a local MCP server for agents on your machine. Those tools answer only when your assistant asks for them. The extension still makes no network call itself, and opens no network port. Your assistant then sends what it read to its own AI service, under that service's privacy policy.

## What else may use the network

Your own tests, your test framework and VS Code itself may use the network. That is outside the extension: it runs them as they are.

## How to check

The extension is open source under the MIT license. Every pull request runs [`noNetwork.test.ts`](packages/vscode-extension/test/noNetwork.test.ts) (part of `pnpm test`). The test scans the source and the built extension for:

- network modules and network APIs
- telemetry, error-reporting and AI-service packages
- any view that could load something from another origin

## Changes and questions

Changes to this policy are listed in the [changelog](CHANGELOG.md). Questions: open an [issue](https://github.com/EshanDias/live-test-runner/issues). Security problems: see [SECURITY.md](SECURITY.md).
