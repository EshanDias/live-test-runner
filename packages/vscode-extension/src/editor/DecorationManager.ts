import * as vscode from 'vscode';
import { ResultStore } from '../store/ResultStore';
import {
  IResultObserver,
  RunStartedPayload,
  RunFinishedPayload,
} from '../IResultObserver';
import { durationLabel, durationColorVar, getThresholds } from '../utils/duration';

export class DecorationManager implements IResultObserver {
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

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(_payload?: RunStartedPayload): void {
    this._refreshAll();
  }

  onSessionStopped(): void {
    // Clear decorations but keep decoration types alive so discovery-sourced
    // pending icons can be re-applied without re-creating the types.
    this.clearAll();
  }

  onRunStarted(_payload: RunStartedPayload): void {}

  onFilesRerunning(fileIds: string[], suiteId?: string, testId?: string): void {
    for (const filePath of fileIds) {
      this._store.markTestsRunning(filePath, suiteId, testId);
      this._refreshFile(filePath);
    }
  }

  onFileResult(filePath: string): void {
    this._refreshFile(filePath);
  }

  onRunFinished(_payload: RunFinishedPayload): void {}

  onDiscoveryProgress(_file: unknown, _discovered: number, _total: number): void {
    this._refreshAll();
  }

  onDiscoveryComplete(): void {
    this._refreshAll();
  }

  dispose(): void {
    this.clearAll();
    for (const type of Object.values(this._types)) {
      type.dispose();
    }
  }

  // ── Public helpers ─────────────────────────────────────────────────────────

  applyToEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const lineMap = this._store.getLineMap(filePath);

    const buckets: Record<string, vscode.DecorationOptions[]> = {
      passed: [],
      failed: [],
      running: [],
      pending: [],
    };

    for (const [line, entry] of lineMap) {
      let status: string;
      let duration: number | null;
      let durationLevel: 'test' | 'suite';

      if (entry.testId) {
        const test = this._store.getTest(entry.fileId, entry.suiteId, entry.testId);
        status        = test?.status   ?? 'pending';
        duration      = test?.duration ?? null;
        durationLevel = 'test';
      } else {
        const suite = this._store.getSuite(entry.fileId, entry.suiteId);
        status        = suite?.status   ?? 'pending';
        duration      = suite?.duration ?? null;
        durationLevel = 'suite';
      }

      const range = new vscode.Range(line - 1, 0, line - 1, 0);

      const durationText =
        duration != null && status !== 'running'
          ? `  ${durationLabel(duration)}`
          : '';

      const durationColor =
        duration == null ? '' : durationColorVar(duration, durationLevel, getThresholds());

      const decoration: vscode.DecorationOptions = {
        range,
        renderOptions: {
          after: {
            contentText: durationText,
            color: durationColor,
            fontStyle: 'normal',
            margin: '0 0 0 16px',
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

  // ── Private ────────────────────────────────────────────────────────────────

  private _refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyToEditor(editor);
    }
  }

  private _refreshFile(filePath: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === filePath) {
        this.applyToEditor(editor);
      }
    }
  }

  private _icon(name: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this._context.extensionUri,
      'resources',
      'icons',
      `${name}.svg`,
    );
  }
}
