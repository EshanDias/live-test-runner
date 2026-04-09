/**
 * duration.ts — shared duration formatting and threshold utilities.
 *
 * Used by DecorationManager (and any future extension-side code) for
 * colour-coded duration labels. The webview mirror is src/webview/utils.js.
 *
 * Thresholds are read from the liveTestRunner.durationThresholds VS Code setting
 * on every call to getThresholds(), so changes take effect on the next run
 * without reloading.
 */
import * as vscode from 'vscode';

export interface DurationThresholds {
  test:  [number, number]; // [amberMs, redMs]
  suite: [number, number];
  file:  [number, number];
}

export const DEFAULT_THRESHOLDS: DurationThresholds = {
  test:  [100,  500],
  suite: [500,  2000],
  file:  [1000, 5000],
};

/** Read thresholds from VS Code settings, falling back to defaults. */
export function getThresholds(): DurationThresholds {
  const dt = vscode.workspace
    .getConfiguration('liveTestRunner')
    .get<Record<string, number>>('durationThresholds') ?? {};
  return {
    test:  [dt.testAmberMs  ?? DEFAULT_THRESHOLDS.test[0],  dt.testRedMs  ?? DEFAULT_THRESHOLDS.test[1]],
    suite: [dt.suiteAmberMs ?? DEFAULT_THRESHOLDS.suite[0], dt.suiteRedMs ?? DEFAULT_THRESHOLDS.suite[1]],
    file:  [dt.fileAmberMs  ?? DEFAULT_THRESHOLDS.file[0],  dt.fileRedMs  ?? DEFAULT_THRESHOLDS.file[1]],
  };
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const parts: string[] = [];
  if (hr)                        parts.push(`${hr}h`);
  if (min % 60)                  parts.push(`${min % 60}m`);
  if (sec % 60 || !parts.length) parts.push(`${sec % 60}s`);
  return parts.join(' ');
}

/** Returns a VS Code CSS variable string for the colour matching the duration and level. */
export function durationColorVar(
  ms: number,
  level: keyof DurationThresholds,
  thresholds: DurationThresholds = DEFAULT_THRESHOLDS,
): string {
  const [amber, red] = thresholds[level];
  if (ms > red)   return 'var(--vscode-terminal-ansiRed)';
  if (ms > amber) return 'var(--vscode-terminal-ansiYellow)';
  return 'var(--vscode-terminal-ansiGreen)';
}
