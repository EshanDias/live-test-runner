/**
 * IResultObserver — cross-cutting event contract for the test run lifecycle.
 *
 * Every layer that reacts to test results (views, editor decorations, codelens)
 * implements this interface. SessionManager drives them all uniformly via _notify().
 *
 * Lives at src/ root because it is consumed by every layer — store, editor,
 * views, and session — and belongs to none of them specifically.
 */
import * as vscode from 'vscode';

export interface RunStartedPayload {
  fileCount: number;
  files: unknown[];
}

export interface RunFinishedPayload {
  total: number;
  passed: number;
  failed: number;
  sessionActive: boolean;
  totalDuration: number | undefined;
}

/**
 * Implemented by any consumer that reacts to test run lifecycle events.
 * Extension wires up all observers and drives them uniformly.
 */
export interface IResultObserver extends vscode.Disposable {
  onSessionStarted(): void;
  onSessionStopped(): void;
  onRunStarted(payload: RunStartedPayload): void;
  onFilesRerunning(fileIds: string[], nodeId?: string): void;
  onFileResult(filePath: string): void;
  onRunFinished(payload: RunFinishedPayload): void;
  onTracingProgress?(completed: number, total: number, done?: boolean): void;

  // ── Static discovery events (optional — no-op on implementors that don't need them) ──

  /** Fired once when the file list is known. `total` is the number of files to parse. */
  onDiscoveryStarted?(total: number): void;
  /**
   * Fired after each file's AST is parsed and its pending tree is in the store.
   * `file` is the serialised FileResult (same shape as full-file-result).
   * `discovered` / `total` drive the progress counter.
   */
  onDiscoveryProgress?(file: unknown, discovered: number, total: number): void;
  /** Fired when all files have been parsed. Start Testing can now be enabled. */
  onDiscoveryComplete?(): void;
}
