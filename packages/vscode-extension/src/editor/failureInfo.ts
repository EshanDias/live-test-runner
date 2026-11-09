/**
 * What a failure message says, for showing it on the failing line: a one-line
 * summary, where it happened, and the expected / received values when the
 * framework printed them. Works on the plain text each framework reports
 * (ANSI already stripped): Jest's failure messages, our Vitest error text,
 * pytest's report.
 */

export interface FailureFrame {
  /** As printed: absolute, or relative to the project (Vitest, pytest). */
  file: string;
  /** 1-based. */
  line: number;
  column?: number;
}

export interface ParsedFailure {
  /** One line for the editor: `Expected 3, received 4`, `TypeError: x is not a function`. */
  summary: string;
  /** The message without its stack trace. */
  message: string;
  /** Stack frames and `file:line` locations, innermost first. */
  frames: FailureFrame[];
  /** Both sides of the comparison, when the message has them (single values or a diff). */
  expected?: string;
  actual?: string;
}

/** `at fn (file:line:col)`, `at file:line:col`, `❯ file:line:col`. */
const STACK_FRAME = /^\s*(?:at\s+(?:.*?\()?|❯\s+)(?:file:\/\/)?((?:[A-Za-z]:)?[^():]+):(\d+):(\d+)\)?\s*$/;
/** pytest: `tests/test_math.py:5: AssertionError` (a frame the error passed through has no name). */
const PYTEST_LOCATION = /^((?:[A-Za-z]:)?[^:\s][^:]*\.py):(\d+):(?: \w[\w.]*)?$/;
/** Frames that belong to the test runner or Node, not to the project. */
const INTERNAL = /[\\/]node_modules[\\/]|^node:|^internal[\\/]|^<anonymous>$/;

/** Jest / Vitest diff headers: `- Expected  - 1` / `+ Received  + 1`, `- Snapshot`. */
const DIFF_MINUS = /^- (Expected|Snapshot)\b/;
const DIFF_PLUS = /^\+ Received\b/;

const MAX_SUMMARY = 160;

export function parseFailure(text: string): ParsedFailure {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const frames: FailureFrame[] = [];
  const messageLines: string[] = [];
  for (const l of lines) {
    const s = STACK_FRAME.exec(l);
    if (s) {
      if (!INTERNAL.test(s[1].replace(/\\/g, '/'))) { frames.push({ file: s[1], line: Number(s[2]), column: Number(s[3]) }); }
      continue;
    }
    if (/^\s+at\s/.test(l)) { continue; } // a stack line without a location (`at new Promise (<anonymous>)`)
    const p = PYTEST_LOCATION.exec(l.trim());
    if (p) { frames.push({ file: p[1], line: Number(p[2]) }); }
    messageLines.push(l);
  }
  // pytest lists the outermost location first (the test, then what it called).
  if (lines.some((l) => PYTEST_LOCATION.test(l.trim()))) { frames.reverse(); }

  const message = messageLines.join('\n').trim();
  const sides = diffSides(messageLines) ?? labelledValues(messageLines);
  return { summary: summaryOf(messageLines, sides), message, frames, ...(sides ?? {}) };
}

/** The `- Expected` / `+ Received` diff turned back into both texts. */
function diffSides(lines: string[]): { expected: string; actual: string } | undefined {
  const start = lines.findIndex((l, i) => DIFF_MINUS.test(l) && DIFF_PLUS.test(lines[i + 1] ?? ''));
  if (start < 0) { return undefined; }
  const expected: string[] = [];
  const actual: string[] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() === '') { i++; }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('- ') || l === '-') { expected.push(l.slice(2)); }
    else if (l.startsWith('+ ') || l === '+') { actual.push(l.slice(2)); }
    else if (l.startsWith('  ')) { expected.push(l.slice(2)); actual.push(l.slice(2)); }
    else if (l === '') {
      // A blank line inside the diff is a blank common line; one before the next part ends it.
      const next = lines[i + 1];
      if (next === undefined || !/^[-+ ] |^[-+]$/.test(next)) { break; }
      expected.push(''); actual.push('');
    } else { break; }
  }
  if (expected.length === 0 && actual.length === 0) { return undefined; }
  return { expected: expected.join('\n'), actual: actual.join('\n') };
}

/** Jest's `Expected: 3` / `Received: 4` (also `Expected value:`, `Received string:` …). */
function labelledValues(lines: string[]): { expected: string; actual: string } | undefined {
  const value = (re: RegExp) => { for (const l of lines) { const m = re.exec(l); if (m) { return m[1]; } } return undefined; };
  const expected = value(/^\s*Expected(?: [\w ]+?)?: (.*)$/);
  const actual = value(/^\s*Received(?: [\w ]+?)?: (.*)$/);
  return expected !== undefined && actual !== undefined ? { expected, actual } : undefined;
}

function summaryOf(lines: string[], sides: { expected: string; actual: string } | undefined): string {
  let s: string;
  if (sides && !sides.expected.includes('\n') && !sides.actual.includes('\n')) {
    s = `Expected ${sides.expected}, received ${sides.actual}`;
  } else {
    // pytest: the first `E   …` line is the error; elsewhere the first line of the message.
    const pyError = lines.find((l) => /^E\s{2,}\S/.test(l));
    const first = pyError ? pyError.replace(/^E\s+/, '') : lines.find((l) => l.trim() !== '') ?? '';
    s = first.trim().replace(/^Error: /, '');
  }
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s;
}
