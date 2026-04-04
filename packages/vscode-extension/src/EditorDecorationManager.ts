import * as vscode from 'vscode';
import { ResultStore } from './ResultStore';

// Matches durationLabel() in testListLayout.js
function durationLabel(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const parts: string[] = [];
  if (hr)              { parts.push(`${hr}h`); }
  if (min % 60)        { parts.push(`${min % 60}m`); }
  if (sec % 60 || !parts.length) { parts.push(`${sec % 60}s`); }
  return parts.join(' ');
}

// Matches THRESHOLDS.test in testListLayout.js
const DURATION_THRESHOLDS = {
  amber: 100,  // < 100ms = green
  red:   500,  // 100–500ms = amber, > 500ms = red
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
      // Read status and duration live from the result tree — LineEntry is identity only
      const test     = this._store.getTest(entry.fileId, entry.suiteId, entry.testId);
      const status   = test?.status ?? 'pending';
      const duration = test?.duration ?? null;

      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      const durationText = duration != null && status !== 'running'
        ? `  ${durationLabel(duration)}`
        : '';

      const durationColor = duration == null
        ? ''
        : duration < DURATION_THRESHOLDS.amber
          ? 'var(--vscode-terminal-ansiGreen)'
          : duration < DURATION_THRESHOLDS.red
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

      buckets[status]?.push(decoration);
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
