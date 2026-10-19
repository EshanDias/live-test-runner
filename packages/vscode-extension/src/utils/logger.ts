/**
 * logger.ts — levelled logger for the Live Test Runner extension.
 *
 * Writes to a VS Code LogOutputChannel ("Live Test Runner"), which gives us:
 *  - native levels: trace / debug / info / warning / error
 *  - timestamps and a level badge on every line
 *  - a user-selectable level (Output panel ⚙ → "Set Log Level", or
 *    "Developer: Set Log Level…") — debug/trace are hidden by default
 *
 * Line format:  [Area] message
 *   e.g.        [Session] Run #3 finished — 12 files · 140 passed · 2 failed · 4.1s
 *
 * Extras:
 *  - runner/core packages log through the same channel (setLogSink)
 *  - identical consecutive lines are collapsed into "repeated N more times"
 *  - lines logged before init() are buffered, then flushed into the channel
 *  - the last RING_SIZE debug+ lines are kept in memory (even when the
 *    channel hides them) for the "Copy Diagnostic Report" command
 *
 * Usage:
 *   const log = logger.scope('Session');
 *   log.info('Session started');
 *   log.error('Could not start Jest', err);
 */

import * as vscode from 'vscode';
import { setLogSink } from '@live-test-runner/runner';
import type { LogLevel, ScopedLogger } from '@live-test-runner/runner';

export type { LogLevel, ScopedLogger };

const RING_SIZE = 1000;
const MAX_STACK_FRAMES = 6;
const REPEAT_FLUSH_MS = 2000;

const LEVEL_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** vscode.LogLevel → our level name (Off maps to error so nothing extra is produced). */
function fromVscodeLevel(level: vscode.LogLevel): LogLevel {
  switch (level) {
    case vscode.LogLevel.Trace:   return 'trace';
    case vscode.LogLevel.Debug:   return 'debug';
    case vscode.LogLevel.Info:    return 'info';
    case vscode.LogLevel.Warning: return 'warn';
    default:                      return 'error';
  }
}

function formatError(level: LogLevel, err: unknown): string {
  if (err == null || err === '') { return ''; }
  if (!(err instanceof Error)) { return ` — ${String(err)}`; }
  // Stacks are only useful for real failures; warnings get the message alone.
  if (level !== 'error' || !err.stack) { return ` — ${err.message}`; }
  const frames = err.stack
    .split('\n')
    .slice(1, 1 + MAX_STACK_FRAMES)
    .map((l) => '    ' + l.trim())
    .join('\n');
  return ` — ${err.message}${frames ? '\n' + frames : ''}`;
}

type Pending = { level: LogLevel; text: string };

class LtrLogger {
  private _channel: vscode.LogOutputChannel | undefined;
  private _pending: Pending[] = [];
  private readonly _ring: string[] = [];

  private _last: { key: string; level: LogLevel; count: number } | undefined;
  private _repeatTimer: ReturnType<typeof setTimeout> | undefined;

  /** Call once in activate(). Also routes runner/core package logs here. */
  init(channel: vscode.LogOutputChannel): void {
    this._channel = channel;
    setLogSink((level, scope, message, err) => this._log(level, scope, message, err));
    const pending = this._pending;
    this._pending = [];
    for (const p of pending) { this._write(p.level, p.text); }
  }

  /** A logger whose lines are prefixed with `[name]`. */
  scope(name: string): ScopedLogger {
    return {
      trace: (m) => this._log('trace', name, m),
      debug: (m) => this._log('debug', name, m),
      info:  (m) => this._log('info', name, m),
      warn:  (m, e) => this._log('warn', name, m, e),
      error: (m, e) => this._log('error', name, m, e),
    };
  }

  /** The channel's current level (what the user chose). */
  get level(): LogLevel {
    return this._channel ? fromVscodeLevel(this._channel.logLevel) : 'info';
  }

  /** True when a message at `level` would be shown — use to skip expensive formatting. */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  /** Recent debug-and-above lines (newest last), regardless of the channel level. */
  recentLines(): string[] {
    return [...this._ring];
  }

  show(): void {
    this._channel?.show(true);
  }

  dispose(): void {
    this._flushRepeat();
    setLogSink(undefined);
    this._channel = undefined;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _log(level: LogLevel, scope: string, message: string, err?: unknown): void {
    this._write(level, `[${scope}] ${message}${formatError(level, err)}`);
  }

  private _write(level: LogLevel, text: string): void {
    if (!this._channel) {
      if (this._pending.length < RING_SIZE) { this._pending.push({ level, text }); }
      return;
    }

    // Collapse identical consecutive lines (e.g. the same warning for 300 files).
    const key = `${level}\u0000${text}`;
    if (this._last?.key === key) {
      this._last.count++;
      this._armRepeatFlush();
      return;
    }
    this._flushRepeat();
    this._last = { key, level, count: 0 };
    this._out(level, text);
  }

  private _armRepeatFlush(): void {
    if (this._repeatTimer) { return; }
    this._repeatTimer = setTimeout(() => {
      this._repeatTimer = undefined;
      this._flushRepeat();
      this._last = undefined;
    }, REPEAT_FLUSH_MS);
  }

  private _flushRepeat(): void {
    if (this._repeatTimer) { clearTimeout(this._repeatTimer); this._repeatTimer = undefined; }
    if (this._last && this._last.count > 0) {
      const n = this._last.count;
      this._last.count = 0;
      this._out(this._last.level, `  ↑ previous message repeated ${n} more time${n === 1 ? '' : 's'}`);
    }
  }

  private _out(level: LogLevel, text: string): void {
    if (level !== 'trace') {
      this._ring.push(`${new Date().toISOString()} [${level}] ${text}`);
      if (this._ring.length > RING_SIZE) { this._ring.shift(); }
    }

    const ch = this._channel!;
    switch (level) {
      case 'trace': ch.trace(text); break;
      case 'debug': ch.debug(text); break;
      case 'info':  ch.info(text); break;
      case 'warn':  ch.warn(text); break;
      case 'error':
        ch.error(text);
        // Mirror errors to the Extension Host console (Help → Toggle Developer Tools).
        console.error(`[LTR] ${text}`);
        break;
    }
  }
}

/** Singleton — use `logger.scope('Area')` in each module. */
export const logger = new LtrLogger();
