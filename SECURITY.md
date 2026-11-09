# Security policy

## Supported versions

Security fixes go into the latest released version of the extension. Please update to the newest version from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=EshLabs.live-test-runner) or [Open VSX](https://open-vsx.org/extension/EshLabs/live-test-runner) before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub: **Security → Report a vulnerability** on this repository ([direct link](https://github.com/EshanDias/live-test-runner/security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer as soon as possible, and the fix will be credited to you in the release notes unless you prefer otherwise.

## Scope

Live Test Runner runs your project's own test framework (Jest, Vitest, pytest) in child processes and reads their results. What the extension keeps and never sends is in [PRIVACY.md](PRIVACY.md). Reports about the extension making a network call, running code it should not, writing outside its own temp and cache folders, or exposing data from your project are especially welcome.
