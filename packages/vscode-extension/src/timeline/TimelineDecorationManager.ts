/**
 * TimelineDecorationManager.ts — highlights the active line in the editor
 * as the user steps through the timeline.
 *
 * Uses a dedicated TextEditorDecorationType so it never touches the existing
 * pass/fail gutter decorations managed by DecorationManager.ts.
 */
import * as vscode from 'vscode';

export class TimelineDecorationManager {
  private readonly _decorationType: vscode.TextEditorDecorationType;

  constructor() {
    this._decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      borderColor: new vscode.ThemeColor('focusBorder'),
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
    });
  }

  /**
   * Highlight `line` in the file at `filePath`. If the file is not the current
   * active editor, open it first then apply the decoration.
   */
  async highlight(filePath: string, line: number): Promise<void> {
    if (!filePath || line < 1) { return; }

    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(line - 1, 0);
    const range = new vscode.Range(pos, pos);

    // Find the editor for this file (may already be open).
    let editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === uri.fsPath,
    );

    if (!editor) {
      // Open the file but don't steal focus from the timeline panel.
      const doc = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: true,
        preview: true,
      });
    }

    this._clearAll();
    editor.setDecorations(this._decorationType, [range]);

    // Scroll the editor to make the decorated line visible.
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Remove all timeline highlight decorations from every open editor.
   * Call this when exiting timeline mode.
   */
  clearAll(): void {
    this._clearAll();
  }

  dispose(): void {
    this._decorationType.dispose();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._decorationType, []);
    }
  }
}
