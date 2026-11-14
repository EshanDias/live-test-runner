/**
 * The AI-assistant tools and ready-made tasks, defined once.
 *
 * Both ways in read this list: the VS Code language-model tools (Copilot;
 * `contributes.languageModelTools` in package.json must match it, checked by
 * test/aiCatalog.test.ts) and the MCP relay (`out/mcp.js`, for Cursor and
 * terminal agents). Tool names are a public API from 3.5.0: a rename breaks
 * users' instructions and needs a changelog line.
 *
 * No VS Code import: the relay bundles this file.
 */

/** JSON Schema of a tool's input (the subset both MCP and VS Code use). */
export interface InputSchema {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'array';
    description: string;
    enum?: string[];
    items?: { type: 'string' };
  }>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  /** Short title (VS Code's displayName, MCP's title). */
  title: string;
  /** What the model reads to decide when to call it. */
  description: string;
  inputSchema: InputSchema;
  /** Starts or stops something (runs, cache restart, the snapshot dialog); otherwise it only reads. */
  acts?: boolean;
  /** How long the relay waits for the answer (ms); the handler answers sooner. */
  timeoutMs?: number;
}

const ID = { type: 'string' as const, description: 'A test, suite or file id as other LTR_ tools return it (a file path relative to the workspace also works for files).' };
const LIMIT = (n: number) => ({ type: 'number' as const, description: `Most items to return (default ${n}).` });

export const TOOLS: ToolDef[] = [
  // ── Understand the state ──────────────────────────────────────────────────
  {
    name: 'LTR_get_status',
    title: 'Test status',
    description: 'Live Test Runner status for this workspace: projects and frameworks, whether the live session is on, whether tests are running (progress), files changed and waiting for a rerun, and the pass / fail / skip counts. Call it first, and after editing code to see whether results are up to date (the `stale` and `running` flags), instead of running the test command yourself.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'LTR_get_project_info',
    title: 'Project info',
    description: 'How a test project is set up: root, framework(s) and which framework runs which test file in a mixed project, config files, test file count, coverage provider and the equivalent terminal command.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or root; default: every project.' } } },
  },
  {
    name: 'LTR_list_tests',
    title: 'List tests',
    description: 'The test tree (files → suites → tests) with status, duration and line, filtered by file, status or name. Ids in the answer work with every other LTR_ tool.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Only this test file (path, or part of it).' },
        status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'todo', 'pending', 'running'], description: 'Only tests with this status.' },
        name: { type: 'string', description: 'Only tests whose full name contains this text (case-insensitive).' },
        limit: LIMIT(100),
      },
    },
  },
  {
    name: 'LTR_find_tests',
    title: 'Find tests',
    description: 'Find tests by name, file path, or `file:line` (the test at or around that line). Returns ids ready for LTR_explain_failure, LTR_run_tests and the other tools.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Test name text, a file path, or file:line.' }, limit: LIMIT(20) }, required: ['query'] },
  },

  // ── Fix failures ──────────────────────────────────────────────────────────
  {
    name: 'LTR_get_failures',
    title: 'Failing tests',
    description: 'What is broken: each failing test with id, name, file:line and the first line of its error. Start here to fix failing tests, then call LTR_explain_failure for one of them.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Only this test file.' }, limit: LIMIT(20) } },
  },
  {
    name: 'LTR_explain_failure',
    title: 'Explain a failure',
    description: 'Everything needed to fix one failing test in one call: the full error and stack, the failing line with the code around it, the test\'s code, its console output, the source lines it ran (when traced) and the expected / received values or snapshot diff.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
  },
  {
    name: 'LTR_get_output',
    title: 'Test output',
    description: 'Console output (console.log / print) of a test, suite or file, as captured at that scope. A scope that never ran on its own says so: output is never guessed.',
    inputSchema: { type: 'object', properties: { id: ID, limit: { type: 'number', description: 'Most lines to return (default 200).' } }, required: ['id'] },
  },
  {
    name: 'LTR_verify_fix',
    title: 'Verify a fix',
    description: 'After you changed code: reruns the tests affected by the changed files and answers with the difference — fixed, still failing, newly failing (regressions). Without `files` it uses the files changed since the last run. Waits up to ~50 s; if the run is longer, it returns a runId for LTR_get_run.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'Files you changed (paths). Default: the files changed since the last run.' } } },
    acts: true,
    timeoutMs: 70_000,
  },

  // ── Know what a change touches ────────────────────────────────────────────
  {
    name: 'LTR_get_affected_tests',
    title: 'Affected tests',
    description: 'The tests that run a file, or a line range of it, from the per-test execution trace (else the test files that import it). Use before changing code to know what to rerun.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source or test file path.' },
        startLine: { type: 'number', description: 'First line (1-based), optional.' },
        endLine: { type: 'number', description: 'Last line (1-based), optional.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'LTR_get_test_path',
    title: 'Lines a test ran',
    description: 'The source files and lines one test executed (from the trace): what the test really depends on.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
  },

  // ── Coverage and writing tests ────────────────────────────────────────────
  {
    name: 'LTR_get_coverage',
    title: 'Coverage',
    description: 'Coverage as the project\'s own coverage tool measures it. With `file`: covered / uncovered lines, branch and function counts, and the test files that cover it. Without: totals and the files with the lowest coverage.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'A source file; default: the project summary.' }, limit: LIMIT(20) } },
  },
  {
    name: 'LTR_find_untested',
    title: 'Untested code',
    description: 'Uncovered code to write tests for: the largest uncovered line ranges with their code, in one file or across the project. Use for "write tests for X", then LTR_verify_fix.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'A source file; default: the whole project.' }, limit: LIMIT(10) } },
  },
  {
    name: 'LTR_check_change_coverage',
    title: 'Is my change tested?',
    description: 'For a line range you changed: which lines no test runs, and which tests run the others.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source file path.' },
        startLine: { type: 'number', description: 'First line (1-based).' },
        endLine: { type: 'number', description: 'Last line (1-based).' },
      },
      required: ['file', 'startLine', 'endLine'],
    },
  },

  // ── Housekeeping ──────────────────────────────────────────────────────────
  {
    name: 'LTR_get_slow_tests',
    title: 'Slow tests',
    description: 'The slowest tests and test files of the last runs, with durations.',
    inputSchema: { type: 'object', properties: { limit: LIMIT(10) } },
  },
  {
    name: 'LTR_get_skipped',
    title: 'Skipped tests',
    description: 'Skipped and todo tests, with ids and lines.',
    inputSchema: { type: 'object', properties: { limit: LIMIT(50) } },
  },
  {
    name: 'LTR_get_diagnostics',
    title: 'Diagnostics',
    description: 'Live Test Runner\'s own diagnostic report and recent log lines. For "Live Test Runner does not find / run my tests".',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Act ───────────────────────────────────────────────────────────────────
  {
    name: 'LTR_run_tests',
    title: 'Run tests',
    description: 'Runs tests, suites or files by id, exactly like the user\'s ▶ Run button (no ids: every test file). Answers at once with a runId; call LTR_get_run for the result.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Test, suite or file ids (or file paths). Empty: everything.' } } },
    acts: true,
  },
  {
    name: 'LTR_run_failed',
    title: 'Rerun failing tests',
    description: 'Reruns only the failing tests. Answers at once with a runId; call LTR_get_run for the result.',
    inputSchema: { type: 'object', properties: {} },
    acts: true,
  },
  {
    name: 'LTR_get_run',
    title: 'Run result',
    description: 'Waits (up to `wait` seconds, default 30) for a run started by LTR_run_tests, LTR_run_failed or LTR_verify_fix, then answers its state; once finished, the counts, failing test ids and what changed. Call again while `state` is "running".',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The runId to check.' }, wait: { type: 'number', description: 'Seconds to wait for the run to finish (0–30, default 30).' } }, required: ['runId'] },
    timeoutMs: 45_000,
  },
  {
    name: 'LTR_cancel_run',
    title: 'Cancel a run',
    description: 'Cancels a run you started (it stops after the test file in progress). Never stops the user\'s live session.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The runId to cancel.' } }, required: ['runId'] },
    acts: true,
  },
  {
    name: 'LTR_clear_cache_and_restart',
    title: 'Clear cache and restart',
    description: 'Clears the project\'s cached test list and restarts the live session (every test reruns). Only while the session is on; use when results look wrong or tests are missing after config changes.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or root; default: the project shown in the panels.' } } },
    acts: true,
  },
  {
    name: 'LTR_update_snapshot',
    title: 'Update a snapshot',
    description: 'Asks the user (in a dialog naming the file) whether to update a failing test\'s snapshot; the test framework rewrites it only on a yes. Answers what the user chose.',
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    acts: true,
    timeoutMs: 600_000,
  },
  {
    name: 'LTR_show',
    title: 'Show to the user',
    description: 'Shows a test result to the user in the Results panel (by id), or opens a file at a line (`file:line`) with its coverage.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: 'A test / suite / file id, or file:line.' } }, required: ['target'] },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Ready-made tasks (MCP prompts; Claude Code shows them as slash commands). */
export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
  /** The message sent as the user's, with `{arg}` placeholders. */
  text: string;
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'LTR_fix_failing_tests',
    title: 'Fix failing tests',
    description: 'Find the failing tests, fix them one by one and verify.',
    text: 'Fix the failing tests in this workspace. Call LTR_get_failures, then for each failure LTR_explain_failure, decide whether the test or the code is wrong, fix it, and call LTR_verify_fix. Repeat until LTR_get_failures is empty or only failures you cannot fix are left; then summarise what you changed and what is left.',
  },
  {
    name: 'LTR_explain_failure',
    title: 'Why does this test fail?',
    description: 'Explain one failing test without changing code.',
    arguments: [{ name: 'test', description: 'Test name, file or file:line (optional: the first failure).' }],
    text: 'Explain why this test fails: {test}. Use LTR_find_tests (or LTR_get_failures when no test is named) and LTR_explain_failure. Do not change any code; explain the cause and suggest a fix.',
  },
  {
    name: 'LTR_check_my_change',
    title: 'Check my change',
    description: 'Rerun what the latest changes affect and report regressions.',
    text: 'Check my latest changes: call LTR_verify_fix (no files: the files changed since the last run). Report what was fixed, what still fails and any regressions; for each regression call LTR_explain_failure and say what in the change caused it.',
  },
  {
    name: 'LTR_write_tests_for',
    title: 'Write tests for…',
    description: 'Write tests for untested code, then verify them.',
    arguments: [{ name: 'file', description: 'Source file to test (optional: the least covered code).' }],
    text: 'Write tests for the untested code in {file}. Call LTR_find_untested for it, write tests in the project\'s existing style and test framework (LTR_get_project_info), then call LTR_verify_fix with the new test files and LTR_get_coverage to confirm the lines are now covered.',
  },
  {
    name: 'LTR_speed_up_tests',
    title: 'Speed up slow tests',
    description: 'Find the slowest tests and suggest how to make them faster.',
    text: 'Call LTR_get_slow_tests, look at the slowest tests\' code and suggest concrete ways to make them faster without losing what they check. Do not change code until I agree.',
  },
  {
    name: 'LTR_troubleshoot',
    title: 'Troubleshoot Live Test Runner',
    description: 'Find out why Live Test Runner does not find or run tests.',
    text: 'Live Test Runner is not behaving as expected. Call LTR_get_status, LTR_get_project_info and LTR_get_diagnostics, find the likely cause and tell me how to fix it (settings or project setup). Do not change files.',
  },
];

/** A prompt's text with its arguments filled in (missing ones read as "the first one" / "the project"). */
export function promptText(p: PromptDef, args: Record<string, string | undefined>): string {
  return p.text.replace(/\{(\w+)\}/g, (_m, k: string) => (args[k] && String(args[k]).trim()) || (k === 'file' ? 'the least covered code of the project' : 'the first failing test'));
}
