import * as fs from 'fs';
import * as path from 'path';
import { ConsoleEntry, FileRunResult, RunResult } from '../types';
import { VITEST_FILE_FAILURE, VITEST_HOOK_FAILURE, parseVitestResult } from '../parsing/VitestResultParser';
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
 *   { "ev": "file-start", "file" }                      a test file starts running
 *   { "ev": "test-start", "file", "name" } / { "ev": "test-end", "file" }   heartbeats (hang limit)
 *   { "ev": "file-end", "file", "result" }              the file's result, in the json reporter's shape
 *
 * Live events use the reporter API of Vitest 3+ (onTestModuleStart / End,
 * onTestCaseReady / Result) and onTaskUpdate before (Vitest 2 already has
 * part of the new API but not those hooks, so the choice is by version).
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

const STATUS = { fail: 'failed', only: 'pending', pass: 'passed', run: 'pending', skip: 'skipped', todo: 'todo', queued: 'pending' };

/** A finished file task as the json reporter writes it (testResults[]). */
function fileResult(file) {
  const tests = [];
  const walk = (task, ancestors) => {
    for (const t of task.tasks || []) {
      if (t.type === 'suite') { walk(t, t.name ? [...ancestors, t.name] : ancestors); continue; }
      const r = t.result || {};
      tests.push({
        ancestorTitles: ancestors, title: t.name, fullName: [...ancestors, t.name].join(' '),
        status: STATUS[r.state || t.mode] || 'pending',
        duration: typeof r.duration === 'number' ? r.duration : null,
        failureMessages: (r.errors || []).map((e) => (e && (e.stack || e.message)) || String(e)),
        location: t.location || null,
      });
    }
  };
  walk(file, []);
  const fr = file.result || {};
  const failed = fr.state === 'fail' || tests.some((t) => t.status === 'failed');
  const startTime = fr.startTime || Date.now();
  return {
    name: file.filepath, status: failed ? 'failed' : 'passed',
    message: (fr.errors && fr.errors[0] && fr.errors[0].message) || '',
    startTime, endTime: startTime + (fr.duration || 0),
    assertionResults: tests,
  };
}

function fileOf(task) {
  let t = task;
  while (t && t.suite) { t = t.suite; }
  return t && (t.filepath || (t.file && t.file.filepath));
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
  onInit(ctx) {
    this.ctx = ctx;
    this.modern = parseInt(String(ctx && ctx.version), 10) >= 3;
    this.ended = new Set();   // files whose result was written
    this.started = new Set();
  }

  /** A file is done: its result and failures (once). */
  endFile(file) {
    if (!file || this.ended.has(file.id)) { return; }
    this.ended.add(file.id);
    failures(file); // before file-end: a live reader applies the result on file-end
    write({ ev: 'file-end', file: file.filepath, result: fileResult(file) });
  }

  // ── Vitest 3+ ──
  onTestModuleStart(m) { if (this.modern && m) { write({ ev: 'file-start', file: m.moduleId }); } }
  onTestCaseReady(tc) { if (this.modern && tc) { write({ ev: 'test-start', file: tc.module && tc.module.moduleId, name: tc.name }); } }
  onTestCaseResult(tc) { if (this.modern && tc) { write({ ev: 'test-end', file: tc.module && tc.module.moduleId }); } }
  onTestModuleEnd(m) { if (this.modern && m && m.task) { this.endFile(m.task); } }

  // ── Vitest 1 – 2 ──
  onTaskUpdate(packs) {
    if (this.modern) { return; }
    const idMap = this.ctx && this.ctx.state && this.ctx.state.idMap;
    for (const [id, result] of packs || []) {
      const task = idMap && idMap.get(id);
      if (!task || !result) { continue; }
      // Only file tasks carry a filepath (suites have no parent link on Vitest 2).
      const isFile = task.type === 'suite' && typeof task.filepath === 'string';
      const state = result.state;
      if (isFile) {
        if (!this.started.has(id)) { this.started.add(id); write({ ev: 'file-start', file: task.filepath }); }
        if (state === 'pass' || state === 'fail' || state === 'skip') { this.endFile(task); }
      } else if (task.type !== 'suite') {
        const file = (task.file && task.file.filepath) || fileOf(task);
        if (state === 'run') { write({ ev: 'test-start', file, name: task.name }); }
        else if (state) { write({ ev: 'test-end', file }); }
      }
    }
  }

  // ── Run end: anything not reported yet (crashed files, older hooks) ──
  onTestRunEnd(modules) {
    for (const m of modules || []) { if (m && m.task) { this.endFile(m.task); } }
  }

  onFinished(files) {
    for (const f of files || []) { this.endFile(f); }
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
export type VitestEvent = VitestLogEvent | VitestErrorEvent | VitestLiveEvent;

/** Progress while the run is going: a file / test started, a test ended, a file's result. */
export interface VitestLiveEvent {
  ev: 'file-start' | 'test-start' | 'test-end' | 'file-end';
  file?: string;
  /** test-start: the test's own name. */
  name?: string;
  /** file-end: the file's result in the json reporter's shape (one testResults[] entry). */
  result?: unknown;
}

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
  let text = '';
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

/**
 * Adds what the reporter saw to a RunResult: console output per file with
 * its scope, and failures with diff and location (a failing beforeAll /
 * afterAll included — the json report leaves it out).
 */
export function applyVitestEvents(result: RunResult, events: VitestEvent[], projectRoot: string): RunResult {
  const logs = new Map<string, ReturnType<typeof toConsoleEntry>[]>();
  const errors = new Map<string, VitestErrorEvent[]>();
  for (const e of events) {
    if (!e.file) { continue; }
    const key = fileKey(e.file);
    if (e.ev === 'log') {
      const list = logs.get(key) ?? [];
      list.push(toConsoleEntry(e));
      logs.set(key, list);
    } else if (e.ev === 'error') {
      const list = errors.get(key) ?? [];
      list.push(e);
      errors.set(key, list);
    }
  }
  for (const fr of result.fileResults) {
    const key = fileKey(fr.testFilePath);
    const entries = logs.get(key);
    if (entries) { fr.consoleOutput = [...fr.consoleOutput, ...entries]; }

    const outside: string[] = [];
    for (const ev of errors.get(key) ?? []) {
      const messages = ev.errors.map((err) => formatVitestError(err, projectRoot));
      if (ev.scope === 'test') {
        const name = ev.names.join(' ');
        const tc = fr.testCases.find((c) => c.fullName === name && c.status === 'failed');
        if (tc) { tc.failureMessages = messages; }
      } else {
        const where = ev.scope === 'suite' ? `In "${ev.names.join(' > ')}" (a beforeAll / afterAll hook or the suite itself):\n` : '';
        outside.push(...messages.map((m) => where + m));
      }
    }
    if (outside.length) {
      const known = fr.failureMessage && fr.failureMessage !== VITEST_HOOK_FAILURE && fr.failureMessage !== VITEST_FILE_FAILURE;
      // A load error is already in the json report's message; the reporter adds its location.
      fr.failureMessage = known && !outside.some((m) => m.startsWith(fr.failureMessage!.split('\n')[0]))
        ? [fr.failureMessage!, ...outside].join('\n\n')
        : outside.join('\n\n');
      fr.status = 'failed';
    }
  }
  return result;
}

/** A file-end event as a FileRunResult (parsed like the json report). */
export function liveFileResult(ev: VitestLiveEvent): FileRunResult | undefined {
  if (ev.ev !== 'file-end' || !ev.result) { return undefined; }
  return parseVitestResult(true, JSON.stringify({ testResults: [ev.result] }), '').fileResults[0];
}
