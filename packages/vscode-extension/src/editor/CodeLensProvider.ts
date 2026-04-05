import * as vscode from 'vscode';
import { ResultStore } from '../store/ResultStore';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';

const BLOCK_PATTERN = /^\s*(describe|it|test)\s*[\.(]/;
const SUITE_PATTERN = /^\s*describe\s*[\.(]/;

export class CodeLensProvider implements vscode.CodeLensProvider, IResultObserver {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly _store: ResultStore) {}

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(_payload?: RunStartedPayload): void { this.refresh(); }
  onSessionStopped(): void                             { this.refresh(); }
  onRunStarted(_payload: RunStartedPayload): void      {}
  onFilesRerunning(_fileIds: string[]): void           {}
  onFileResult(_filePath: string): void                { this.refresh(); }
  onRunFinished(_payload: RunFinishedPayload): void    {}
  dispose(): void                                      { this._onDidChange.dispose(); }

  // ── CodeLensProvider ───────────────────────────────────────────────────────

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;
    const lineMap  = this._store.getLineMap(filePath);

    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (!BLOCK_PATTERN.test(text)) { continue; }

      const lineNumber = i + 1;
      const isSuite    = SUITE_PATTERN.test(text);
      const entry      = lineMap.get(lineNumber);
      const range      = new vscode.Range(i, 0, i, 0);

      lenses.push(new vscode.CodeLens(range, {
        title:     '▶ Run',
        command:   'liveTestRunner.rerunFromEditor',
        arguments: [filePath, lineNumber],
      }));

      lenses.push(new vscode.CodeLens(range, {
        title:     '▷ Debug',
        command:   'liveTestRunner.debugFromEditor',
        arguments: [filePath, lineNumber],
      }));

      if (!isSuite && entry) {
        lenses.push(new vscode.CodeLens(range, {
          title:     '◈ Results',
          command:   'liveTestRunner.focusResult',
          arguments: [entry.fileId, entry.suiteId, entry.testId],
        }));
      }
    }

    return lenses;
  }
}
