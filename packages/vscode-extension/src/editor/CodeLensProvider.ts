import * as vscode from 'vscode';
import { ResultStore } from '../store/ResultStore';

/**
 * CodeLensProvider — shows inline Run / Debug / Results actions for
 * every test and suite in the active editor.
 *
 * Uses the same LineMap as DecorationManager. Each line entry maps to a
 * node in the ResultStore's flat node pool.
 */
export class CodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly store: ResultStore) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lineMap = this.store.getLineMap(document.uri.fsPath);
    if (lineMap.size === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;

    for (const [line, entry] of lineMap) {
      const range = new vscode.Range(line - 1, 0, line - 1, 0);
      const node = this.store.getNode(entry.nodeId);
      if (!node) {
        continue;
      }

      // ▶ Run
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Run',
          command: 'liveTestRunner.rerunScope',
          arguments: [
            {
              scope: node.type,
              fileId: entry.fileId,
              nodeId: entry.nodeId,
              fullName: node.fullName,
            },
          ],
        }),
      );

      // ▷ Debug
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▷ Debug',
          command: 'liveTestRunner.debugFromEditor',
          arguments: [filePath, node.fullName],
        }),
      );

      // ◈ Results — jump to this node in the results panel
      lenses.push(
        new vscode.CodeLens(range, {
          title: '◈ Results',
          command: 'liveTestRunner.focusResult',
          arguments: [entry.fileId, entry.nodeId],
        }),
      );

      // 📷 Update Snapshot
      if (node.isSnapshot) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '📷 Update Snapshot',
            command: 'liveTestRunner.rerunScope',
            arguments: [
              {
                scope: node.type,
                fileId: entry.fileId,
                nodeId: entry.nodeId,
                fullName: node.fullName,
                updateSnapshots: true,
              },
            ],
          }),
        );
      }
    }

    return lenses;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
