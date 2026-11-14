# AI assistants

**In one line:** your AI assistant (Copilot, Cursor, Claude Code, Codex, Gemini CLI…) reads Live Test Runner's live results itself, explains failures, reruns what its change affects and checks for regressions, without you copying anything.

| | |
|---|---|
| **Who it is for** | Anyone who lets an AI assistant change code and wants it to check its work against the tests |
| **Frameworks** | Jest (including Create React App), Vitest, Angular, pytest |
| **Requirements** | [AI assistants: requirements](../requirements/ai-assistants.md) |
| **How it is built** | [AI assistants: design](../development/design/ai-assistants.md) |

---

## The problem

An assistant that changes code has to find out whether the tests still pass. Without help it runs the whole test command in a terminal, waits, and reads pages of output, again and again. It does not know which tests a change affects, which line a test failed on, or what coverage says. Copying failures into the chat by hand works, but only once, and only for what you copied.

## What Live Test Runner does

Live Test Runner already has the answers: every test's result and output, where it failed, the source lines each test ran, and coverage. It now gives your assistant **tools** (all named `LTR_…`) to ask for them while it works:

| The assistant wants to… | It calls |
|---|---|
| know whether results are current and what fails | `LTR_get_status`, `LTR_get_failures` |
| understand one failure: error, failing line, the test's code, its output, the lines it ran | `LTR_explain_failure` |
| check its fix: rerun what the changed files affect and list fixed tests and regressions | `LTR_verify_fix` |
| know which tests run a function before changing it | `LTR_get_affected_tests`, `LTR_get_test_path` |
| write tests for untested code | `LTR_find_untested`, `LTR_get_coverage`, `LTR_check_change_coverage` |
| find tests, read output, see slow or skipped tests | `LTR_find_tests`, `LTR_list_tests`, `LTR_get_output`, `LTR_get_slow_tests`, `LTR_get_skipped` |
| run tests, like ▶ Run | `LTR_run_tests`, `LTR_run_failed`, `LTR_get_run`, `LTR_cancel_run` |
| fix a stuck session, update a snapshot (you still confirm), show you a result | `LTR_clear_cache_and_restart`, `LTR_update_snapshot`, `LTR_show` |
| find out why Live Test Runner misbehaves | `LTR_get_diagnostics` |

Answers are short: counts, ids, the first line of an error. The assistant asks for detail only where it needs it.

### Connecting your assistant

| Assistant | What to do |
|---|---|
| **GitHub Copilot** (VS Code 1.95 or newer) | Nothing: Copilot Chat in agent mode sees the tools |
| **Cursor** | Nothing: Cursor's agent sees the tools |
| **Claude Code, Codex CLI, Gemini CLI** | Run one command, once. **Live Test Runner: Connect Your AI Assistant** shows it with a Copy button |
| **Windsurf, Cline, other MCP assistants** | Paste a short snippet into the assistant's global MCP settings (on the same page) |

The command is the same for every project and survives extension updates. Nothing is added to your project.

### Fix with AI

A failing test gets **✨ Fix with AI** above it, in the Results panel's Errors pane, and as a quick fix on the failure in the **Problems** list. It opens your assistant's chat (Copilot in VS Code) with a request to fix that test using the tools. Where no chat can be opened (Cursor, other editors) it copies the failure for you to paste.

Failing tests are listed in the **Problems** panel too, so your editor's own AI quick fixes (Copilot's "Fix", Cursor's "Fix in chat") work on them.

### Ready-made tasks

Assistants that support MCP prompts (Claude Code shows them as `/` commands) get ready-made tasks: fix failing tests, explain a failure, check my change, write tests for a file, speed up slow tests, troubleshoot Live Test Runner.

### Example

You ask Claude Code: *"fix the failing tests"*. It calls `LTR_get_failures` (one failure: `cart totals prices`), then `LTR_explain_failure`, which shows a `TypeError` thrown at `src/cart.js:2` and the test's code. It fixes the line, calls `LTR_verify_fix` with `src/cart.js`, and reads back: fixed `cart totals prices`, no regressions. It never ran the test command in a terminal.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `liveTestRunner.ai.bridge` | on | Gives your assistant the tools. Off: no assistant can read or run anything |
| `liveTestRunner.ai.allowRuns` | `always` | `always`: the assistant can run tests (your assistant still asks you per tool call); `ask`: a dialog before each run; `never`: read only |
| `liveTestRunner.ai.fixWithAI` | on | Shows ✨ Fix with AI on failing tests |
| `liveTestRunner.showFailuresInProblems` | on | Lists failing tests in the Problems panel |

## Good to know

- **It never starts or stops testing.** That stays with you. Runs the assistant starts behave like ▶ Run: they share the machine's budget, show in the panels, and the status bar says who started them.
- **Without a live session**, results don't update on save; the assistant can still read them and run tests. `LTR_get_status` tells it so.
- **The assistant and the editor must run on the same computer.** With Remote-SSH, WSL or containers, run the assistant where the extension runs.
- **Same folder in two windows:** a terminal assistant talks to the newest one; `LTR_get_status` names the other.
- **Sandboxed assistants** must be allowed to write to the system temp folder, where the window's session folder is.
- **Test output is untrusted text.** Answers tell the assistant to treat errors and output as data, not instructions.
- **Snapshots:** `LTR_update_snapshot` opens the usual dialog naming the file; only your yes changes it.
- **Privacy:** what the assistant can see and where it goes is in [PRIVACY.md](../../PRIVACY.md#your-ai-assistant). The extension calls no AI service and opens no network port.

## Related

- [Results panel](results-panel.md): Copy for AI, Fix with AI
- [User guide: AI assistants](https://eshandias.github.io/live-test-runner/guide/#ai-assistants)
