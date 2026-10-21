import { FileRunResult, RunResult, TestCaseRunResult } from '../types';
import { createLogger, stripAnsi } from '../utils/logger';
import { fromRunnerPath } from '../resolution/RunnerPaths';
import { mergeByFile } from './mergeFileResults';
import { emptyRunResult } from './runResults';

const log = createLogger('VitestResultParser');

/** Shown when a file failed but the report says nothing about why (a failing beforeAll / afterAll). */
export const VITEST_HOOK_FAILURE =
  'The file failed outside its tests — usually in a beforeAll / afterAll hook. ' +
  "Vitest's JSON report does not include that error; run the file in a terminal to see it.";
/** Shown when a file failed before any test was collected and the report gives no reason. */
export const VITEST_FILE_FAILURE =
  "The file failed before any test ran. Vitest's JSON report gives no reason; run the file in a terminal to see it.";
/** Shown when Vitest exited with an error although every test and file passed. */
export const VITEST_UNHANDLED_ERROR =
  'Vitest exited with an error although every test passed — usually an unhandled error or ' +
  'promise rejection outside a test. Its JSON report has no details; run the tests in a terminal to see it.';

const STATUSES = new Set<TestCaseRunResult['status']>(['passed', 'failed', 'pending', 'todo', 'skipped']);

/**
 * Parses the result of `vitest run --reporter=json` (Vitest 1 – 5) into a RunResult.
 *
 * The json reporter writes Jest's shape (`testResults[].assertionResults[]`),
 * with these differences, all seen in real reports (test/fixtures/vitest):
 *  - Vitest 1 reports the file as an ancestor with an empty title
 *    (`ancestorTitles: ['', 'Outer']`, `fullName: ' Outer adds'`) — dropped.
 *  - Vitest 1 counts are unreliable (8 passed for 4) — counts come from the tests.
 *  - A file that cannot load / has no tests: no tests, reason in `message`
 *    (Jest calls it `failureMessage`).
 *  - A failing beforeAll/afterAll: file `failed`, empty `message`, its tests
 *    `skipped` (Vitest ≥ 2) or `pending` (1) — the error is not in the report.
 *  - An unhandled error: exit code 1 but every test and file passed.
 *  - `location` needs `--includeTaskLocation` (Vitest ≥ 3). Vitest 1 sets it
 *    on failed tests only, to the assertion's position — not the test's line.
 *  - Durations are fractional milliseconds.
 *  - No console output (the json reporter drops it; task 3.1).
 */
export function parseVitestResult(passed: boolean, raw: string, stderr: string): RunResult {
  let json: { testResults?: unknown[] };
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const why = stripAnsi(stderr).trim().split(/\r?\n/).slice(-15).join('\n    ');
    log.error(
      `Could not read Vitest's JSON result (${raw.trim() ? 'invalid JSON' : 'no output'}). Vitest said:\n    ${why || '(nothing)'}`,
      err,
    );
    return emptyRunResult(false, [stderr || raw || 'Vitest failed to produce JSON output']);
  }

  const fileResults = mergeByFile((json.testResults ?? []).map((fr) => parseFile(fr as VitestFileJson)));
  const cases = fileResults.flatMap((f) => f.testCases);
  const count = (...s: TestCaseRunResult['status'][]) => cases.filter((c) => s.includes(c.status)).length;

  let errors: string[] = [];
  if (!passed) {
    const anyFailed = fileResults.some((f) => f.status === 'failed') || count('failed') > 0;
    errors = [stderr.trim() || (anyFailed || fileResults.length === 0 ? 'Tests failed' : VITEST_UNHANDLED_ERROR)];
  }

  return {
    passed,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    // Like Jest and Vitest: skipped tests, not todo ones.
    numPendingTests: count('skipped', 'pending'),
    fileResults,
    errors,
  };
}

// ── Private ───────────────────────────────────────────────────────────────────

interface VitestFileJson {
  name?: string;
  status?: string;
  message?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: VitestTestJson[];
}

interface VitestTestJson {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
  location?: { line: number; column?: number } | null;
}

function parseFile(fr: VitestFileJson): FileRunResult {
  const testCases = (fr.assertionResults ?? []).map(parseTest);

  // Vitest 1: locations only on failed tests are assertion positions, not test lines.
  const located = testCases.filter((c) => c.location);
  if (located.length > 0 && located.length < testCases.length && located.every((c) => c.status === 'failed')) {
    for (const c of testCases) { c.location = undefined; }
  }

  const failed = fr.status === 'failed' || testCases.some((c) => c.status === 'failed');
  let failureMessage = stripAnsi(fr.message ?? '').trim() || undefined;
  if (!failureMessage && failed && !testCases.some((c) => c.status === 'failed')) {
    failureMessage = testCases.length === 0 ? VITEST_FILE_FAILURE : VITEST_HOOK_FAILURE;
  }

  const timed = fr.startTime && fr.endTime ? fr.endTime - fr.startTime : 0;
  const duration = timed > 0 ? timed : testCases.reduce((s, c) => s + (c.duration ?? 0), 0);

  return {
    testFilePath: fromRunnerPath(fr.name ?? ''),
    status: failed ? 'failed' : 'passed',
    testCases,
    consoleOutput: [],
    failureMessage,
    duration: duration > 0 ? duration : undefined,
  };
}

function parseTest(tc: VitestTestJson): TestCaseRunResult {
  const ancestors = [...(tc.ancestorTitles ?? [])];
  if (ancestors[0] === '') { ancestors.shift(); } // Vitest 1: the file as an unnamed suite
  const title = tc.title ?? '';
  const status = STATUSES.has(tc.status as TestCaseRunResult['status'])
    ? (tc.status as TestCaseRunResult['status'])
    : 'skipped'; // e.g. "disabled"
  return {
    ancestorTitles: ancestors,
    title,
    fullName: [...ancestors, title].join(' '),
    status,
    duration: typeof tc.duration === 'number' ? Math.round(tc.duration) : undefined,
    failureMessages: (tc.failureMessages ?? []).map(withoutStack),
    location: tc.location ? { line: tc.location.line, column: tc.location.column ?? 0 } : undefined,
  };
}

/** The error text without its stack trace (`    at …` lines) — the stack is noise in the UI. */
function withoutStack(message: string): string {
  const lines = stripAnsi(message).split('\n');
  const stackAt = lines.findIndex((l) => /^\s+at\s/.test(l));
  return (stackAt < 0 ? lines : lines.slice(0, stackAt)).join('\n').trimEnd();
}
