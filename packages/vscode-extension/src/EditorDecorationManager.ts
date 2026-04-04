import * as vscode from 'vscode';
import { ResultStore } from './ResultStore';

const DURATION_THRESHOLDS = {
  green: 100,  // < 100ms
  amber: 500,  // 100ms – 500ms
  // > 500ms = red
};

export class EditorDecorationManager {
  private _types = {
    passed: vscode.window.createTextEditorDecorationType({
      gutterIconPath: this._icon('passed'),
      gutterIconSize: 'contain',
    }),
    failed: vscode.window.createTextEditorDecorationType({
      gutterIconPath: this._icon('failed'),
      gutterIconSize: 'contain',
    }),
    running: vscode.window.createTextEditorDecorationType({
      gutterIconPath: this._icon('running'),
      gutterIconSize: 'contain',
    }),
    pending: vscode.window.createTextEditorDecorationType({
      gutterIconPath: this._icon('pending'),
      gutterIconSize: 'contain',
    }),
  };

  constructor(
    private readonly _store: ResultStore,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  private _icon(name: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this._context.extensionUri,
      'resources',
      'icons',
      `${name}.svg`,
    );
  }

  applyToEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const lineMap  = this._store.getLineMap(filePath);

    const buckets: Record<string, vscode.DecorationOptions[]> = {
      passed: [], failed: [], running: [], pending: [],
    };

    for (const [line, entry] of lineMap) {
      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      const durationText = entry.duration != null
        ? `  ${entry.duration}ms`
        : '';

      const durationColor = entry.duration == null
        ? ''
        : entry.duration < DURATION_THRESHOLDS.green
          ? 'var(--vscode-terminal-ansiGreen)'
          : entry.duration < DURATION_THRESHOLDS.amber
            ? 'var(--vscode-terminal-ansiYellow)'
            : 'var(--vscode-terminal-ansiRed)';

      const decoration: vscode.DecorationOptions = {
        range,
        renderOptions: {
          after: {
            contentText: durationText,
            color:       durationColor,
            fontStyle:   'normal',
            margin:      '0 0 0 16px',
          },
        },
      };

      buckets[entry.status]?.push(decoration);
    }

    for (const [state, opts] of Object.entries(buckets)) {
      editor.setDecorations(
        this._types[state as keyof typeof this._types],
        opts,
      );
    }
  }

  clearEditor(editor: vscode.TextEditor): void {
    for (const type of Object.values(this._types)) {
      editor.setDecorations(type, []);
    }
  }

  clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearEditor(editor);
    }
  }

  dispose(): void {
    this.clearAll();
    for (const type of Object.values(this._types)) {
      type.dispose();
    }
  }
}
