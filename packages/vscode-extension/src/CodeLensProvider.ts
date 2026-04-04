import * as vscode from 'vscode';
import { ResultStore } from './ResultStore';

const BLOCK_PATTERN = /^\s*(describe|it|test)\s*[\.(]/;
const SUITE_PATTERN = /^\s*describe\s*[\.(]/;

export class LiveTestCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly _store: ResultStore) {}

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

      const lineNumber = i + 1;  // 1-based, matches Jest location.line
      const isSuite    = SUITE_PATTERN.test(text);
      const entry      = lineMap.get(lineNumber);
      const range      = new vscode.Range(i, 0, i, 0);

      // ▶ Run
      lenses.push(new vscode.CodeLens(range, {
        title:     '▶ Run',
        command:   'liveTestRunner.rerunFromEditor',
        arguments: [filePath, lineNumber],
      }));

      // ▷ Debug
      lenses.push(new vscode.CodeLens(range, {
        title:     '▷ Debug',
        command:   'liveTestRunner.debugFromEditor',
        arguments: [filePath, lineNumber],
      }));

      // ◈ Results — only on it/test lines with a known result
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
