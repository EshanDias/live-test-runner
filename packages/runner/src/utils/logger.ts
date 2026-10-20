/**
 * logger.ts — pluggable, levelled logger shared by the runner and core packages.
 *
 * These packages must not depend on VS Code, so they log through a "sink".
 * The default sink writes to the console (visible in the Extension Host
 * developer tools). The extension replaces it at activation via setLogSink()
 * so every runner/core message lands in the "Live Test Runner" log channel
 * with the correct level.
 *
 * Usage:
 *   const log = createLogger('Executor');
 *   log.warn('Output file missing — falling back to stdout');
 *   log.error('Spawn failed', err);
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Receives every log record. `scope` is a short area name, e.g. "Executor". */
export type LogSink = (level: LogLevel, scope: string, message: string, err?: unknown) => void;

export interface ScopedLogger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

const consoleSink: LogSink = (level, scope, message, err) => {
  const line = `[LTR][${level.toUpperCase()}][${scope}] ${message}${err ? ` — ${describeError(err)}` : ''}`;
  if (level === 'error') { console.error(line); }
  else if (level === 'warn') { console.warn(line); }
  else if (level === 'info') { console.log(line); }
  // trace/debug are dropped when no sink is installed — they are too chatty for the console.
};

let _sink: LogSink = consoleSink;

/** Replace the global sink. Pass undefined to restore the console sink. */
export function setLogSink(sink: LogSink | undefined): void {
  _sink = sink ?? consoleSink;
}

export function createLogger(scope: string): ScopedLogger {
  const emit = (level: LogLevel, message: string, err?: unknown) => {
    try { _sink(level, scope, message, err); } catch { /* a broken sink must never break a run */ }
  };
  return {
    trace: (m) => emit('trace', m),
    debug: (m) => emit('debug', m),
    info:  (m) => emit('info', m),
    warn:  (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

/** One-line description of an unknown thrown value (message only, no stack). */
export function describeError(err: unknown): string {
  if (err instanceof Error) { return err.message; }
  if (err == null) { return ''; }
  return String(err);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07|[@-Z\\-_])/g;

/** Removes ANSI colour / cursor escape sequences (OutputChannels cannot render them). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
