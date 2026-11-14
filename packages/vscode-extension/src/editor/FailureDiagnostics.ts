import * as path from 'path';
import * as vscode from 'vscode';
import { IResultObserver } from '../IResultObserver';
import type { ResultStore } from '../store/ResultStore';
import { parseFailure } from './failureInfo';
import { linesIn, resolveFrameFile, samePath } from './FailureDecorations';

const SOURCE = 'Live Test Runner';
const SETTING = 'showFailuresInProblems';

/**
 * Failing tests in the Problems list: one error on the line the test failed
 * at, and one on the line of a source file the error was thrown from. Being
 * ordinary diagnostics, they get the editor's own AI quick fixes for free
 * (Copilot's "Fix", Cursor's "Fix in chat"), plus our "Fix with AI".
 *
 * Built from every project's store whenever results change (debounced);
 * `liveTestRunner.showFailuresInProblems` turns it off.
 */
export class FailureDiagnostics implements Partial<IResultObserver>, vscode.CodeActionProvider, vscode.Disposable {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly _collection = vscode.languages.createDiagnosticCollection('liveTestRunner.failures');
  /** `uri\0line\0message` → the failing test (code actions get copies of the diagnostics). */
  private readonly _tests = new Map<string, { fileId: string; nodeId: string }>();
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _stores: () => ResultStore[]) {
    this._disposables.push(
      this._collection,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`liveTestRunner.${SETTING}`) || e.affectsConfiguration('liveTestRunner.ai.fixWithAI')) { this.refresh(); }
      }),
    );
  }

  onFileResult(): void { this._soon(); }
  onRunFinished(): void { this._soon(); }
  onSessionStopped(): void { this._soon(); }
  onSessionStarted(): void { this._soon(); }
  onDiscoveryFileRemoved(): void { this._soon(); }

  private _soon(): void {
    if (this._timer) { return; }
    this._timer = setTimeout(() => { this._timer = undefined; this.refresh(); }, 300);
  }

  refresh(): void {
    this._collection.clear();
    this._tests.clear();
    if (!vscode.workspace.getConfiguration('liveTestRunner').get<boolean>(SETTING, true)) { return; }
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const store of this._stores()) {
      for (const file of store.getAllFiles()) {
        if (file.status !== 'failed') { continue; }
        for (const node of store.getFileNodes(file.fileId)) {
          if (node.type !== 'test' || node.status !== 'failed' || node.failureMessages.length === 0) { continue; }
          const failure = parseFailure(node.failureMessages[0]);
          const message = `${node.fullName}: ${failure.summary || 'failed'}`;
          const add = (target: string, line: number) => {
            const d = new vscode.Diagnostic(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER), message, vscode.DiagnosticSeverity.Error);
            d.source = SOURCE;
            d.code = 'failing test';
            byFile.set(target, [...(byFile.get(target) ?? []), d]);
            this._tests.set(key(vscode.Uri.file(target), line - 1, message), { fileId: file.fileId, nodeId: node.id });
          };
          // Where it was thrown (a source file), and where the test failed.
          const top = failure.frames[0] ? resolveFrameFile(failure.frames[0].file, file.fileId) : undefined;
          if (top) { for (const line of linesIn(failure.frames, file.fileId, top)) { add(top, line); } }
          const inTest = top && samePath(top, file.fileId) ? [] : linesIn(failure.frames, file.fileId, file.fileId);
          // The test file always lists the failure: its failing line, else the test's own line (a stack that stops in the source, a timeout, a hook).
          if (inTest.length > 0) { for (const line of inTest) { add(file.fileId, line); } }
          else if (!(top && samePath(top, file.fileId)) && node.line) { add(file.fileId, node.line); }
        }
      }
    }
    for (const [file, diags] of byFile) {
      if (path.isAbsolute(file)) { this._collection.set(vscode.Uri.file(file), diags); }
    }
  }

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    if (!vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('ai.fixWithAI', true)) { return []; }
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      if (d.source !== SOURCE) { continue; }
      const test = this._tests.get(key(document.uri, d.range.start.line, d.message));
      if (!test) { continue; }
      const action = new vscode.CodeAction('Fix with AI (Live Test Runner)', vscode.CodeActionKind.QuickFix);
      action.diagnostics = [d];
      action.command = { title: 'Fix with AI', command: 'liveTestRunner.fixWithAI', arguments: [test.fileId, test.nodeId] };
      actions.push(action);
    }
    return actions;
  }

  dispose(): void {
    if (this._timer) { clearTimeout(this._timer); }
    for (const d of this._disposables) { d.dispose(); }
  }
}

function key(uri: vscode.Uri, line0: number, message: string): string {
  return `${uri.toString()}\0${line0}\0${message}`;
}
