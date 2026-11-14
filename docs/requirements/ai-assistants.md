# AI assistants: requirements

What the feature must do, and how we check it does. For the plain-language description see [AI assistants](../features/ai-assistants.md); for how it is built see [the design](../development/design/ai-assistants.md). The [project-wide requirements](project-rules.md) apply too, G12 (no network, AI data only to the user's own tools) above all.

## Functional requirements

| # | The extension must… | Checked by |
|---|---|---|
| A1 | Offer one set of `LTR_` tools to Copilot (VS Code language-model tools) and to MCP agents (Cursor, terminal agents), defined once; package.json declares exactly the catalog's tools | `aiCatalog.test.ts`; e2e `ai-bridge*` (tools/list, `vscode.lm.tools`) |
| A2 | Answer from the stores the extension already holds (results, output, coverage, trace), with workspace-relative paths, no machine paths, and ids every other tool accepts | `aiTools.test.ts`; e2e `ai-bridge`, `ai-bridge-vitest`, `ai-bridge-pytest` |
| A3 | Explain one failure in one answer: the error, expected / received, the stack, the line it was thrown from and the failing line in the test with code around them, the test's code, its output, the lines it ran | `aiTools.test.ts`; e2e `ai-bridge*` |
| A4 | Never back-fill output: a scope that never ran on its own says so | `aiTools.test.ts` (get_output) |
| A5 | Run tests only through the user's own code paths (▶ Run, a save's rerun), one assistant run at a time, cancellable, within the machine's budget; Stop cancels what an assistant queued | `aiTools.test.ts` (runs, cancel); e2e `ai-bridge*` (run_tests, verify_fix) |
| A6 | `LTR_verify_fix`: rerun what the changed files affect (with or without a session) and report fixed tests, tests still failing and regressions against the results before the change | `aiTools.test.ts`; e2e `ai-bridge*` |
| A7 | Never start or stop the session; Clear Cache and Restart only while the session is on; Update snapshot only through the existing dialog | `aiCatalog.test.ts` (no such tools); `aiTools.test.ts` (restart refused when off) |
| A8 | `liveTestRunner.ai.allowRuns`: `never` refuses every run and still answers reads; `ask` asks per run | `aiTools.test.ts`; e2e `ai-bridge*` (never). ⚠️ `ask` has no automated test |
| A9 | Every answer says whether runs are in flight (`running`) and whether files changed after the latest run (`stale`) | `aiTools.test.ts` |
| A10 | Reach terminal agents with no network module: a stdio MCP relay in the .vsix that talks to the window through files in its session folder; started through a launcher in the extension's storage folder whose path survives updates | `aiBridge.test.ts` (the shipped `out/mcp.js` through the launcher); `noNetwork.test.ts` (relay bundle) |
| A11 | Pick the right window: the exact session in Cursor, else the window whose folders hold the agent's folder, newest first; a closed window fails at once, not on a timeout | `aiBridge.test.ts` |
| A12 | Never write into the user's project or another program's settings; the setup page only shows commands the user runs | ⚠️ no automated test (code review: the only files written are in the session folder and the extension's storage folder) |
| A13 | Feature-detect every API newer than the minimum VS Code (`lm.registerTool`, Cursor's MCP registration, `workbench.action.chat.open`); older editors keep every other feature | e2e on the minimum VS Code (the bridge stays quiet). ⚠️ No scenario checks Cursor's registration |
| A14 | List failing tests in the Problems panel (the test file always, and the source line it was thrown from), with a Fix with AI quick fix | e2e `ai-bridge*` |
| A15 | Fix with AI opens the editor's chat with a request naming the tools, else copies the failure; only on the user's click | e2e `ai-bridge*` |
| A16 | `liveTestRunner.ai.bridge` off: no tools, no mailbox, no window note | ⚠️ no test yet |

⚠️ marks a requirement no automated test checks yet.

## Out of scope

- An AI chat participant of our own (`@ltr`): it would have to call a language model itself.
- Reaching an agent on another machine (Remote-SSH, containers): the agent runs where the extension runs.
- Debugging on an assistant's behalf: it cannot read the debugger.
