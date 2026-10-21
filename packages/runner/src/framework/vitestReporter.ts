import * as fs from 'fs';
import * as path from 'path';
import { ConsoleEntry } from '../types';
import { fromRunnerPath } from '../resolution/RunnerPaths';
import { createLogger } from '../utils/logger';

const log = createLogger('VitestReporter');

/** Environment variable naming the JSON-lines file the reporter appends to. */
export const VITEST_EVENTS_ENV = 'LTR_VITEST_EVENTS';

/**
 * A Vitest reporter (Vitest 1 – 5), loaded next to the json reporter with
 * `--reporter=<this file>`. It records what the json report leaves out, one
 * JSON line per event in $LTR_VITEST_EVENTS:
 *
 *   { "ev": "log", "file", "scope": "file"|"suite"|"test", "names": [...], "type": "stdout"|"stderr", "content" }
 *   { "ev": "error", "file", "scope", "names", "errors": [{ "name", "message", "diff", "stack", "stacks" }] }
 *
 * Failures come from the finished task tree (`onTestRunEnd` on Vitest 3+,
 * `onFinished` before — 4+ dropped it): the json report has no diffs, no
 * error locations and nothing at all for a failing beforeAll / afterAll.
 *
 * Console output comes from `onUserConsoleLog` with the task that printed
 * it (`ctx.state.idMap`). Vitest 1 tags module-scope output with
 * "<file>:<line>:<col>" instead of a task id.
 */
const REPORTER_SOURCE = `import fs from 'node:fs';
import path from 'node:path';

const out = process.env.${VITEST_EVENTS_ENV};
const write = (rec) => { if (out) { try { fs.appendFileSync(out, JSON.stringify(rec) + '\\n'); } catch {} } };

/**
 * The chain of tasks from the file down to \${id}. Parent links (task.suite)
 * are not filled in for suites on every version, so the chain is found by
 * searching the file's tree (ids are hierarchical: file_0_1 is a child of file_0).
 */
function chain(idMap, id) {
  const fileId = String(id).split('_')[0];
  const file = idMap.get(fileId);
  if (!file) { return undefined; }
  const path = [];
  const find = (t) => {
    path.push(t);
    if (t.id === id) { return true; }
    for (const c of t.tasks || []) { if (find(c)) { return true; } }
    path.pop();
    return false;
  };
  return find(file) ? path : undefined;
}

function failures(file) {
  const filepath = file.filepath;
  const walk = (task, chain) => {
    const errors = (task.result && task.result.errors) || [];
    if (errors.length) {
      const n = chain.map((t) => t.name).filter(Boolean);
      const scope = task === file ? 'file' : task.type === 'suite' ? (n.length ? 'suite' : 'file') : 'test';
      write({
        ev: 'error', file: filepath, scope, names: n,
        errors: errors.map((e) => ({
          name: e && e.name, message: String((e && e.message) || e || ''),
          diff: e && typeof e.diff === 'string' ? e.diff : undefined,
          stack: e && typeof e.stack === 'string' ? e.stack.slice(0, 4000) : undefined,
          stacks: e && Array.isArray(e.stacks) ? e.stacks.slice(0, 10).map((f) => ({ file: f.file, line: f.line, column: f.column })) : undefined,
        })),
      });
    }
    for (const c of task.tasks || []) { walk(c, [...chain, c]); }
  };
  walk(file, []);
}

export default class LtrReporter {
  onInit(ctx) { this.ctx = ctx; }

  onTestRunEnd(modules) {
    if (this.done) { return; }
    this.done = true;
    for (const m of modules || []) { if (m && m.task) { failures(m.task); } }
  }

  onFinished(files) {
    if (this.done) { return; }
    this.done = true;
    for (const f of files || []) { failures(f); }
  }

  onUserConsoleLog(entry) {
    const ctx = this.ctx;
    const idMap = ctx && ctx.state && ctx.state.idMap;
    const tasks = entry.taskId && idMap ? chain(idMap, entry.taskId) : undefined;
    let file, scope = 'file', n = [];
    if (tasks) {
      const task = tasks[tasks.length - 1];
      file = tasks[0].filepath;
      // Skip the file and Vitest 1's unnamed root suite.
      n = tasks.slice(1).map((t) => t.name).filter(Boolean);
      scope = task.type === 'suite' ? (n.length ? 'suite' : 'file') : 'test';
    } else if (entry.taskId && /:\\d+:\\d+$/.test(entry.taskId)) {
      const root = (ctx && ctx.config && ctx.config.root) || process.cwd();
      file = path.resolve(root, entry.taskId.replace(/:\\d+:\\d+$/, ''));
    }
    write({ ev: 'log', file, scope, names: n, type: entry.type, content: String(entry.content ?? '') });
  }
}
`;

const written = new Set<string>();

/** Writes the reporter into `dir` (once per process) and returns its path. */
export function vitestReporterFile(dir: string): string {
  const file = path.join(dir, 'ltr-vitest-reporter.mjs');
  if (!written.has(file) || !fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, REPORTER_SOURCE, 'utf8');
    written.add(file);
  }
  return file;
}

/** One event the reporter wrote. */
export type VitestEvent = VitestLogEvent | VitestErrorEvent;

export interface VitestLogEvent {
  ev: 'log';
  file?: string;
  scope: 'file' | 'suite' | 'test';
  names: string[];
  type: 'stdout' | 'stderr';
  content: string;
}

export interface VitestErrorEvent {
  ev: 'error';
  file?: string;
  scope: 'file' | 'suite' | 'test';
  names: string[];
  errors: VitestReportedError[];
}

export interface VitestReportedError {
  name?: string;
  message: string;
  /** Expected / received diff (ANSI-coloured on Vitest < 4). */
  diff?: string;
  stack?: string;
  /** Parsed, source-mapped frames (Vitest 4+). */
  stacks?: { file: string; line: number; column: number }[];
}

/** Reads (and deletes) the reporter's events file. */
export function readVitestEvents(file: string): VitestEvent[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
  const events: VitestEvent[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    try { events.push(JSON.parse(line)); } catch { bad++; }
  }
  if (bad) { log.warn(`${bad} Vitest reporter line(s) could not be read and were skipped`); }
  return events;
}

/** Comparable spelling of a file path (editor spelling, case-insensitive on Windows). */
export function fileKey(p: string): string {
  const n = path.normalize(fromRunnerPath(p));
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** A reporter log event as a ConsoleEntry with its scope. */
export function toConsoleEntry(e: VitestLogEvent): ConsoleEntry {
  const scopeName = e.names.join(' ');
  return {
    message: e.content.replace(/\r?\n$/, ''),
    type: e.type === 'stderr' ? 'error' : 'log',
    origin: e.names.join(' > '),
    scope: e.scope,
    ...(e.scope === 'file' ? {} : { scopeName }),
  };
}

/** Frames that are the test runner's, not the project's. */
const INTERNAL_FRAME = /[\\/]node_modules[\\/]|^node:|^internal[\\/]|[\\/](vitest|@vitest|vite-node|tinypool|tinyspy)[\\/]/;
/** `at fn (file:line:col)` / `at file:line:col` / `❯ file:line:col`. */
const FRAME_RE = /^\s*(?:at\s+(?:.*?\()?|❯\s+)(?:file:\/\/)?((?:[A-Za-z]:)?[^():]+):(\d+):(\d+)\)?\s*$/;

/** The first frame in the project's own code: from `stacks` (Vitest 4+) or the stack text. */
export function errorLocation(e: VitestReportedError): { file: string; line: number; column: number } | undefined {
  const frames = e.stacks?.length
    ? e.stacks
    : (e.stack ?? '').split('\n').map((l) => FRAME_RE.exec(l)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ file: m[1], line: Number(m[2]), column: Number(m[3]) }));
  return frames.find((f) => f.file && !INTERNAL_FRAME.test(f.file.replace(/\\/g, '/')));
}

/**
 * One error as the Results panel shows it: `Name: message`, the diff, and
 * where it happened (`❯ src/a.test.ts:5:30`, relative to the project root) —
 * what Vitest's own output shows.
 */
export function formatVitestError(e: VitestReportedError, projectRoot: string): string {
  const plain = (s: string) => stripAnsiText(s).trimEnd();
  const message = plain(e.message);
  const head = e.name && e.name !== 'Error' && !message.startsWith(`${e.name}:`) ? `${e.name}: ${message}` : message;
  const parts = [head];
  if (e.diff && plain(e.diff)) { parts.push(plain(e.diff)); }
  const loc = errorLocation(e);
  if (loc) {
    const rel = path.relative(projectRoot, fromRunnerPath(loc.file));
    parts.push(`❯ ${rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : loc.file}:${loc.line}:${loc.column}`);
  }
  return parts.join('\n\n');
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;
function stripAnsiText(s: string): string {
  return s.replace(ANSI, '');
}
