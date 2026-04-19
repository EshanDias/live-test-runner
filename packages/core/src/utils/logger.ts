/**
 * logger.ts — structured console logger for the @live-test-runner/core package.
 *
 * All log lines follow the format:
 *   [LTR][YYYY-MM-DD HH:mm:ss.mmm][LEVEL][file > function] message
 *
 * Output appears in the VS Code Extension Host developer panel
 * ("Help > Toggle Developer Tools").
 */

const PREFIX = '[LTR]';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const stackLines = (err.stack ?? '')
      .split('\n')
      .slice(1)
      .map((l) => '        ' + l.trim())
      .join('\n');
    return `\n    Error: ${err.message}${stackLines ? '\n    Stack:\n' + stackLines : ''}`;
  }
  if (err != null && err !== '') {
    return `\n    ${String(err)}`;
  }
  return '';
}

function emit(level: string, file: string, fn: string, message: string, err?: unknown): void {
  const line = `${PREFIX}[${timestamp()}][${level}][${file} > ${fn}] ${message}${formatError(err)}`;
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (file: string, fn: string, message: string, err?: unknown) =>
    emit('DEBUG', file, fn, message, err),
  info: (file: string, fn: string, message: string, err?: unknown) =>
    emit('INFO', file, fn, message, err),
  warn: (file: string, fn: string, message: string, err?: unknown) =>
    emit('WARN', file, fn, message, err),
  error: (file: string, fn: string, message: string, err?: unknown) =>
    emit('ERROR', file, fn, message, err),
};
