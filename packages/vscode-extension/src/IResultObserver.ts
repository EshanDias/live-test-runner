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
}

/**
 * Implemented by any consumer that reacts to test run lifecycle events.
 * Extension wires up all observers and drives them uniformly.
 */
export interface IResultObserver extends vscode.Disposable {
  onSessionStarted(): void;
  onSessionStopped(): void;
  onRunStarted(payload: RunStartedPayload): void;
  onFilesRerunning(fileIds: string[], suiteId?: string, testId?: string): void;
  onFileResult(filePath: string): void;
  onRunFinished(payload: RunFinishedPayload): void;
}
