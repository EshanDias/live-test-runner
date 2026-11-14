import * as fs from 'fs';
import * as path from 'path';
import { OutputLine, TestNode } from '../store/ResultStore';
import type { ResultStore } from '../store/ResultStore';
import { CopyFailure, failuresAsText, failuresForAI } from './copyText';
import { BaseWebviewProvider } from './BaseWebviewProvider';
import { RunFinishedPayload } from '../IResultObserver';
import * as vscode from 'vscode';

// ── Scoped log payload types ───────────────────────────────────────────────────

export type LogSection = {
  label: string;
  scope: 'file' | 'suite' | 'test';
  capturedAt: number | null;
  lines: OutputLine[];
};

export type ErrorEntry = {
  /** The test, for the copy buttons. */
  nodeId: string;
  testName: string;
  failureMessages: string[];
  capturedAt: number | null;
};

export type ErrorSection = {
  label: string;
  scope: 'file' | 'suite' | 'test';
  errors: ErrorEntry[];
};

export type ScopedLogPayload = {
  logSections: LogSection[];
  errorSections: ErrorSection[];
};

export class ResultsView extends BaseWebviewProvider {
  public static readonly viewId = 'liveTestRunner.results';

  protected get _htmlFile(): string { return 'results.html'; }

  // ── IResultObserver overrides ──────────────────────────────────────────────

  /** Queue the file result for batched delivery; immediately refresh scoped logs if selected. */
  onFileResult(filePath: string): void {
    super.onFileResult(filePath); // buffers into 50 ms batch
    const sel = this.selection.get();
    if (sel?.fileId === filePath) {
      this.sendScopedData(sel.fileId, sel.nodeId);
    }
  }

  onRunFinished(payload: RunFinishedPayload): void {
    super.onRunFinished(payload);
  }

  bindProject(state: Parameters<BaseWebviewProvider['bindProject']>[0]): void {
    super.bindProject(state);
    // The previous project's logs / errors must not stay on screen.
    this.postMessage({ type: 'scope-logs', payload: { logSections: [], errorSections: [] } });
  }

  // ── Results-view-specific ──────────────────────────────────────────────────

  sendScopedData(fileId: string, nodeId?: string): void {
    this._sendScopedLogs(fileId, nodeId);
  }

  /** Called by extension.ts so it can forward step-changed to ExplorerView. */
  onStepChanged: ((stepId: number, filePath: string, line: number) => void) | null = null;

  /** Called by extension.ts when the timeline view is unmounted (route → results). */
  onTimelineExit: (() => void) | null = null;
  /** Called when timeline UI asks host to exit timeline mode. */
  onTimelineExitRequest: (() => void) | null = null;

  protected handleExtraMessage(msg: { type: string; fileId?: string; nodeId?: string; nodeIds?: string[]; mode?: string; stepId?: number; filePath?: string; line?: number; view?: string; testFullName?: string }): void {
    if (msg.type === 'open-timeline' && msg.filePath && msg.testFullName) {
      vscode.commands.executeCommand(
        'liveTestRunner.openTimelineDebugger',
        msg.filePath,
        msg.testFullName,
      );
      return;
    }
    if (msg.type === 'step-changed' && typeof msg.stepId === 'number') {
      this.onStepChanged?.(msg.stepId, msg.filePath ?? '', msg.line ?? 0);
      return;
    }
    if (msg.type === 'timeline-exited') {
      this.onTimelineExit?.();
      return;
    }
    if (msg.type === 'timeline-exit-request') {
      this.onTimelineExitRequest?.();
      return;
    }
    if (msg.type === 'copy-failures' && Array.isArray(msg.nodeIds)) {
      void this.copyFailures(msg.nodeIds, msg.mode === 'ai' ? 'ai' : 'all');
    }
    if (msg.type === 'fix-with-ai' && Array.isArray(msg.nodeIds)) {
      const node = msg.nodeIds.map((id) => this.store.getNode(id)).find((n) => n?.type === 'test' && n.status === 'failed');
      if (node) { void vscode.commands.executeCommand('liveTestRunner.fixWithAI', node.fileId, node.id); }
    }
  }

  /** Framework name and project root of a test file (set by extension.ts). */
  frameworkOf: ((testFile: string) => { framework: string; root: string } | undefined) | null = null;

  /** Copy all / Copy for AI from the Errors pane: to the clipboard only. */
  async copyFailures(nodeIds: string[], mode: 'all' | 'ai'): Promise<string | undefined> {
    const failures = failuresOf(this.store, nodeIds);
    if (failures.length === 0) { return undefined; }
    let text: string;
    if (mode === 'all') {
      text = failuresAsText(failures);
    } else {
      const owner = this.frameworkOf?.(failures[0].testFile);
      text = failuresForAI(failures, owner?.framework ?? 'test framework', owner?.root ?? path.dirname(failures[0].testFile), readText);
    }
    await vscode.env.clipboard.writeText(text);
    this.postMessage({ type: 'copied', mode });
    return text;
  }

  /** Shows / hides "Fix with AI" (liveTestRunner.ai.fixWithAI). */
  sendAiSettings(): void {
    this.postMessage({ type: 'ai-settings', fixWithAI: vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('ai.fixWithAI', true) });
  }

  protected _sendInit(): void {
    const sel     = this.selection.get();
    const summary = this.store.getSummary();
    const hasData = summary.total > 0;
    this.postMessage({
      type:       'init',
      files:      (this.store.toJSON() as { files: unknown[] }).files,
      thresholds: this._getThresholds(),
      selection:  sel ? { fileId: sel.fileId, nodeId: sel.nodeId } : null,
      total:      hasData ? summary.total  : null,
      passed:     hasData ? summary.passed : null,
      failed:     hasData ? summary.failed : null,
    });
    this.sendAiSettings();
  }

  // ── Scoped log builders ────────────────────────────────────────────────────

  private _sendScopedLogs(fileId: string, nodeId?: string): void {
    const payload = this._buildScopedLogPayload(fileId, nodeId);
    this.postMessage({ type: 'scope-logs', payload });
  }

  private _buildScopedLogPayload(fileId: string, nodeId?: string): ScopedLogPayload {
    if (nodeId) {
      return this._buildNodePayload(fileId, nodeId);
    }
    return this._buildFilePayload(fileId);
  }

  private _buildFilePayload(fileId: string): ScopedLogPayload {
    const fileResult = this.store.getFile(fileId);
    if (!fileResult) { return { logSections: [], errorSections: [] }; }

    const fileOutput = this.store.getFileOutput(fileId);
    const logSections: LogSection[] = [{
      label: fileResult.filePath, scope: 'file',
      capturedAt: fileOutput.capturedAt, lines: fileOutput.lines,
    }];

    // Walk all nodes in this file, collecting logs and errors
    const allNodes = this.store.getFileNodes(fileId);
    for (const node of allNodes) {
      if (node.output.capturedAt !== null && node.output.lines.length > 0) {
        logSections.push({
          label: node.name,
          scope: node.type === 'test' ? 'test' : 'suite',
          capturedAt: node.output.capturedAt,
          lines: node.output.lines,
        });
      }
    }

    // Collect errors from all test nodes
    const fileErrors: ErrorEntry[] = [];
    for (const node of allNodes) {
      if (node.type === 'test' && node.failureMessages.length > 0) {
        fileErrors.push({
          nodeId: node.id,
          testName: node.name,
          failureMessages: node.failureMessages,
          capturedAt: node.output.capturedAt ?? fileOutput.capturedAt,
        });
      }
    }

    const errorSections: ErrorSection[] = fileErrors.length > 0
      ? [{ label: fileResult.filePath, scope: 'file', errors: fileErrors }]
      : [];

    return { logSections, errorSections };
  }

  private _buildNodePayload(fileId: string, nodeId: string): ScopedLogPayload {
    const node = this.store.getNode(nodeId);
    if (!node) { return { logSections: [], errorSections: [] }; }

    const nodeOutput = this.store.getNodeOutput(nodeId);
    const scope: 'suite' | 'test' = node.type === 'test' ? 'test' : 'suite';

    const logSections: LogSection[] = [{
      label: node.name, scope,
      capturedAt: nodeOutput.capturedAt, lines: nodeOutput.lines,
    }];

    // For suites: include descendant nodes' logs and errors
    if (node.type === 'suite') {
      const descendants = this._collectDescendants(nodeId);
      for (const desc of descendants) {
        if (desc.output.capturedAt !== null && desc.output.lines.length > 0) {
          logSections.push({
            label: desc.name,
            scope: desc.type === 'test' ? 'test' : 'suite',
            capturedAt: desc.output.capturedAt,
            lines: desc.output.lines,
          });
        }
      }

      const errors: ErrorEntry[] = [];
      for (const desc of descendants) {
        if (desc.type === 'test' && desc.failureMessages.length > 0) {
          errors.push({
            nodeId: desc.id,
            testName: desc.name,
            failureMessages: desc.failureMessages,
            capturedAt: desc.output.capturedAt,
          });
        }
      }

      const errorSections: ErrorSection[] = errors.length > 0
        ? [{ label: node.name, scope: 'suite', errors }]
        : [];

      return { logSections, errorSections };
    }

    // For tests: just this node's errors
    const errorSections: ErrorSection[] = node.failureMessages.length > 0
      ? [{ label: node.name, scope: 'test', errors: [{ nodeId: node.id, testName: node.name, failureMessages: node.failureMessages, capturedAt: nodeOutput.capturedAt }] }]
      : [];

    return { logSections, errorSections };
  }

  /** Collect all descendant nodes (children, grandchildren, etc.) of a given node. */
  private _collectDescendants(nodeId: string): TestNode[] {
    const result: TestNode[] = [];
    const stack = [...(this.store.getNode(nodeId)?.children ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = this.store.getNode(id);
      if (!node) continue;
      result.push(node);
      for (const childId of node.children) {
        stack.push(childId);
      }
    }
    return result;
  }
}

/** The failed tests among `nodeIds`, with where each test's source starts and ends. */
export function failuresOf(store: ResultStore, nodeIds: string[]): CopyFailure[] {
  const out: CopyFailure[] = [];
  for (const id of nodeIds) {
    const node = store.getNode(id);
    if (!node || node.type !== 'test' || node.failureMessages.length === 0) { continue; }
    const starts = store.getFileNodes(node.fileId).map((n) => n.line).filter((l): l is number => l != null && node.line != null && l > node.line);
    out.push({
      fullName: node.fullName,
      testFile: node.fileId,
      line: node.line,
      nextLine: starts.length ? Math.min(...starts) : undefined,
      failureMessages: node.failureMessages,
    });
  }
  return out;
}

/** The saved file: the failures' line numbers are those of the run. */
function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}
