import * as vscode from 'vscode';
import { FileStoresResolver } from './FileStores';

/**
 * CodeLensProvider — shows inline Run / Debug / Results actions for
 * every test and suite in the active editor.
 *
 * Uses the same LineMap as DecorationManager. Each line entry maps to a
 * node in the ResultStore's flat node pool — of the file's own project
 * (phase 7), so ▶ Run / ▷ Debug run in that project. It hears every
 * project's events to refresh the lenses.
 */
export class CodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  private _timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly _resolve: FileStoresResolver) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  /** Coalesces the refreshes driven by results and discovery. */
  private _refreshSoon(): void {
    if (this._timer) { return; }
    this._timer = setTimeout(() => { this._timer = undefined; this.refresh(); }, 200);
  }

  // Observer hooks (any project): the line maps changed.
  onDiscoveryComplete(): void { this._refreshSoon(); }
  onDiscoveryProgress(): void { this._refreshSoon(); }
  onRunFinished(): void { this._refreshSoon(); }
  onSessionStopped(): void { this._refreshSoon(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const store = this._resolve(document.uri.fsPath)?.store;
    const lineMap = store?.getLineMap(document.uri.fsPath);
    if (!store || !lineMap || lineMap.size === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;

    for (const [line, entry] of lineMap) {
      const range = new vscode.Range(line - 1, 0, line - 1, 0);
      const node = store.getNode(entry.nodeId);
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

      // ▷ Debug — the command takes (filePath, line) and resolves the node itself
      lenses.push(
        new vscode.CodeLens(range, {
          title: '▷ Debug',
          command: 'liveTestRunner.debugFromEditor',
          arguments: [filePath, line],
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
    }

    return lenses;
  }

  dispose(): void {
    if (this._timer) { clearTimeout(this._timer); }
    this._onDidChange.dispose();
  }
}
