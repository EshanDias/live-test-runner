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

export default class LtrReporter {
  onInit(ctx) { this.ctx = ctx; }

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
export interface VitestEvent {
  ev: 'log';
  file?: string;
  scope: 'file' | 'suite' | 'test';
  names: string[];
  type: 'stdout' | 'stderr';
  content: string;
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
export function toConsoleEntry(e: VitestEvent): ConsoleEntry {
  const scopeName = e.names.join(' ');
  return {
    message: e.content.replace(/\r?\n$/, ''),
    type: e.type === 'stderr' ? 'error' : 'log',
    origin: e.names.join(' > '),
    scope: e.scope,
    ...(e.scope === 'file' ? {} : { scopeName }),
  };
}
