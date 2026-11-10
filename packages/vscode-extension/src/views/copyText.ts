import * as path from 'path';
import { parseFailure } from '../editor/failureInfo';
import { linesIn, realPath, samePath } from '../editor/FailureDecorations';
import type { ResultStore } from '../store/ResultStore';

/** One failed test, as the copy buttons see it. */
export interface CopyFailure {
  fullName: string;
  /** Absolute path of the test file. */
  testFile: string;
  /** 1-based line of the test, when known. */
  line?: number;
  /** 1-based line where the next test of the file starts (ends this one's source). */
  nextLine?: number;
  failureMessages: string[];
}

/** Reads a file; undefined when it cannot be read. */
export type ReadText = (file: string) => string | undefined;

const MAX_TESTS = 10;
const MAX_SOURCE_LINES = 60;
const CONTEXT = 3;

/** Copy all: every failure as plain text, the way the Errors pane shows it. */
export function failuresAsText(failures: CopyFailure[]): string {
  return failures.map((f) => [`✗ ${f.fullName}`, '', ...f.failureMessages.map((m) => m.trimEnd())].join('\n')).join('\n\n');
}

/**
 * Copy for AI: what an assistant needs to explain or fix the failures —
 * framework, test name and location, the error, the test's source, and the
 * lines of the code it was thrown from. Markdown, for pasting into a chat.
 * Only ever goes to the clipboard.
 */
export function failuresForAI(failures: CopyFailure[], framework: string, projectRoot: string, read: ReadText): string {
  // Paths from the project root (real paths: a framework may print /private/var/… for /var/…).
  const rel = (p: string) => {
    const r = path.relative(realPath(projectRoot), realPath(path.isAbsolute(p) ? p : path.join(projectRoot, p)));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  };
  const parts: string[] = [];
  const shown = failures.slice(0, MAX_TESTS);
  parts.push(shown.length === 1
    ? `A ${framework} test fails. Explain why and suggest a fix.`
    : `${failures.length} ${framework} tests fail. Explain why and suggest fixes.`);

  for (const f of shown) {
    const testText = read(f.testFile);
    const where = f.line ? `${rel(f.testFile)}:${f.line}` : rel(f.testFile);
    parts.push(`## \`${f.fullName}\`\n\nFile: ${where}`);
    // The message without the stack trace, then the project's own frames (no
    // test-runner internals, no machine paths).
    for (const m of f.failureMessages) {
      const parsed = parseFailure(m);
      const frames = parsed.frames.slice(0, 8).map((fr) => `at ${rel(fr.file)}:${fr.line}${fr.column ? `:${fr.column}` : ''}`);
      parts.push(fence([parsed.message, ...(frames.length ? ['', ...frames] : [])].join('\n'), 'text'));
    }

    if (testText !== undefined && f.line) {
      const lines = testText.split(/\r?\n/);
      const end = Math.min(f.nextLine ? f.nextLine - 1 : lines.length, f.line - 1 + MAX_SOURCE_LINES, lines.length);
      const body = trimBlankEnd(lines.slice(f.line - 1, end));
      parts.push(`Test source (${rel(f.testFile)}, lines ${f.line}–${f.line + body.length - 1}):\n\n${fence(body.join('\n'), lang(f.testFile))}`);
    }

    // Where it was thrown, when that is outside the test.
    const failure = f.failureMessages[0] ? parseFailure(f.failureMessages[0]) : undefined;
    const top = failure?.frames[0];
    if (top) {
      const file = resolveLike(top.file, projectRoot);
      const [thrownLine] = linesIn([top], f.testFile, file);
      const inTest = samePath(file, f.testFile);
      const text = !inTest && thrownLine ? read(file) : undefined;
      if (text !== undefined && thrownLine) {
        const lines = text.split(/\r?\n/);
        const from = Math.max(1, thrownLine - CONTEXT);
        const to = Math.min(lines.length, thrownLine + CONTEXT);
        const snippet = lines.slice(from - 1, to).map((l, i) => `${from + i === thrownLine ? '>' : ' '} ${String(from + i).padStart(4)} | ${l}`);
        parts.push(`Thrown from ${rel(file)}:${thrownLine}:\n\n${fence(snippet.join('\n'), 'text')}`);
      }
    }
  }
  if (failures.length > shown.length) { parts.push(`(${failures.length - shown.length} more failing tests not included.)`); }
  return parts.join('\n\n') + '\n';
}

/** Absolute as is; relative (Vitest, pytest) against the project root. */
function resolveLike(file: string, projectRoot: string): string {
  return path.isAbsolute(file) ? file : path.join(projectRoot, file);
}

function trimBlankEnd(lines: string[]): string[] {
  let n = lines.length;
  while (n > 1 && lines[n - 1].trim() === '') { n--; }
  return lines.slice(0, n);
}

/** A fenced block that its own content cannot close. */
function fence(text: string, language: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${language}\n${text}\n${f}`;
}

function lang(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ({ js: 'js', cjs: 'js', mjs: 'js', jsx: 'jsx', ts: 'ts', cts: 'ts', mts: 'ts', tsx: 'tsx', py: 'python', vue: 'vue', svelte: 'svelte' } as Record<string, string>)[ext] ?? '';
}

/** Copy Failing Test Names: `file › full name`, one per line, in tree order. */
export function failingTestNames(store: ResultStore, projectRoot: string): string {
  const out: string[] = [];
  for (const file of store.getAllFiles()) {
    const rel = path.relative(projectRoot, file.fileId).split(path.sep).join('/') || file.fileId;
    for (const n of store.getFileNodes(file.fileId)) {
      if (n.type === 'test' && n.status === 'failed') { out.push(`${rel} › ${n.fullName}`); }
    }
  }
  return out.join('\n');
}
