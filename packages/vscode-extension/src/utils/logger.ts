/**
 * logger.ts — centralised structured logger for the Live Test Runner extension.
 *
 * All log lines follow the format:
 *   [LTR][YYYY-MM-DD HH:mm:ss.mmm][LEVEL][file > function] message
 *   (optional)  Error: <message>
 *               Stack: <frames>
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   logger.error('SessionManager.ts', 'start', 'Failed to start session', err);
 *
 * Initialise once in extension.ts with the OutputChannel so logs appear in
 * the "Live Test Runner" panel. Before init(), all output falls back to
 * console.log / console.error (visible in Extension Host developer tools).
 */

import * as vscode from 'vscode';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const PREFIX = '[LTR]';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const stackLines = (err.stack ?? '')
      .split('\n')
      .slice(1)                              // remove "Error: message" duplicate header
      .map((l) => '        ' + l.trim())
      .join('\n');
    return `\n    Error: ${err.message}${stackLines ? '\n    Stack:\n' + stackLines : ''}`;
  }
  if (err != null && err !== '') {
    return `\n    ${String(err)}`;
  }
  return '';
}

class LtrLogger {
  private _channel: vscode.OutputChannel | undefined;

  /**
   * Call once in activate() — hands the logger its OutputChannel so all
   * structured log lines appear in the "Live Test Runner" output panel.
   */
  init(channel: vscode.OutputChannel): void {
    this._channel = channel;
  }

  debug(file: string, fn: string, message: string, err?: unknown): void {
    this._emit('DEBUG', file, fn, message, err);
  }

  info(file: string, fn: string, message: string, err?: unknown): void {
    this._emit('INFO', file, fn, message, err);
  }

  warn(file: string, fn: string, message: string, err?: unknown): void {
    this._emit('WARN', file, fn, message, err);
  }

  error(file: string, fn: string, message: string, err?: unknown): void {
    this._emit('ERROR', file, fn, message, err);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _emit(
    level: LogLevel,
    file: string,
    fn: string,
    message: string,
    err?: unknown,
  ): void {
    const line = `${PREFIX}[${timestamp()}][${level}][${file} > ${fn}] ${message}${formatError(err)}`;

    // Always write to the output channel if available
    this._channel?.appendLine(line);

    // Also mirror to the Extension Host console so it appears in the
    // developer tools "Output > Extension Host" panel — useful when the
    // output channel isn't visible.
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

// Singleton — imported and used directly by every module in the extension package.
export const logger = new LtrLogger();
