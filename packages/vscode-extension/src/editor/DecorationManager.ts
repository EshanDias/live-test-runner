import * as vscode from 'vscode';
import { FileStoresResolver } from './FileStores';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { getThresholds, durationColorVar, durationLabel } from '../utils/duration';

/**
 * DecorationManager — drives the gutter icons and inline duration badges.
 *
 * Uses a flat `LineMap` and the `ResultStore`'s node pool to look up status
 * and duration for each line in all visible test-file editors.
 *
 * All public IResultObserver methods trigger a refresh for the affected file
 * so editors update in real-time as results arrive.
 *
 * Every file is decorated from its own project's store (phase 7): the
 * selected project only decides what the Explorer / Results panel show.
 * It receives every project's events (not only the selected one's).
 */
export class DecorationManager implements IResultObserver {
  private readonly _decorations: Map<string, vscode.TextEditorDecorationType> = new Map();

  constructor(
    private readonly _resolve: FileStoresResolver,
    private readonly context: vscode.ExtensionContext,
  ) {
    this._ensureDecorations();
  }

  /** Redraws every visible editor (e.g. the projects were re-detected). */
  refresh(): void {
    this._refreshAll();
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(): void {
    this._refreshAll();
  }

  onSessionStopped(): void {
    // Stop clears the stopped project's line maps; other projects' files keep theirs.
    this._refreshAll();
  }

  onRunStarted(_payload: RunStartedPayload): void {
    this._refreshAll();
  }

  onFilesRerunning(fileIds: string[], _nodeId?: string): void {
    for (const fileId of fileIds) {
      this._refreshFile(fileId);
    }
  }

  onFileResult(filePath: string): void {
    this._refreshFile(filePath);
  }

  onRunFinished(_payload: RunFinishedPayload): void {
    this._refreshAll();
  }

  dispose(): void {
    this._clearAll();
    for (const dec of this._decorations.values()) {
      dec.dispose();
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

  private _clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const dec of this._decorations.values()) {
        editor.setDecorations(dec, []);
      }
    }
  }

  public applyToEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const store = this._resolve(filePath)?.store;
    const lineMap = store ? store.getLineMap(filePath) : new Map();
    if (!store || lineMap.size === 0) {
      for (const dec of this._decorations.values()) {
        editor.setDecorations(dec, []);
      }
      return;
    }

    const thresholds = getThresholds();

    const buckets: Record<string, vscode.DecorationOptions[]> = {};
    for (const key of this._decorations.keys()) {
      buckets[key] = [];
    }

    for (const [line, entry] of lineMap) {
      // A line past the end (file shortened since the run) would be clamped
      // to the last line and show its duration at the end of the file.
      if (line < 1 || line - 1 >= editor.document.lineCount) { continue; }
      const node = store.getNode(entry.nodeId);
      if (!node) {
        continue;
      }

      // End of the line, so the duration text follows the code.
      const lineLength = editor.document.lineAt(line - 1).text.length;
      const range = new vscode.Range(line - 1, lineLength, line - 1, lineLength);
      const status = node.status;
      const statusKey = `status-${status}`;

      // Handle duration
      let durationText = '';
      let durationColor = '';
      if (node.type === 'test' && node.duration != null && status !== 'running') {
        durationText = `  ${durationLabel(node.duration)}`;
        durationColor = durationColorVar(node.duration, 'test', thresholds);
      } else if (node.type === 'suite' && node.duration != null && status !== 'running') {
        durationText = `  ${durationLabel(node.duration)}`;
        durationColor = durationColorVar(node.duration, 'suite', thresholds);
      }

      if (buckets[statusKey]) {
        buckets[statusKey].push({
          range,
          renderOptions: {
            after: {
              contentText: durationText,
              color: durationColor,
              fontStyle: 'normal',
              margin: '0 0 0 16px',
            },
          },
        });
      }
    }

    for (const [key, dec] of this._decorations) {
      editor.setDecorations(dec, buckets[key] ?? []);
    }
  }

  private _icon(name: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
      'icons',
      `${name}.svg`,
    );
  }

  private _ensureDecorations(): void {
    const add = (key: string, opts: vscode.DecorationRenderOptions) => {
      if (!this._decorations.has(key)) {
        this._decorations.set(key, vscode.window.createTextEditorDecorationType(opts));
      }
    };
    add('status-passed', {
      gutterIconPath: this._icon('passed'),
      gutterIconSize: 'contain',
    });
    add('status-failed', {
      gutterIconPath: this._icon('failed'),
      gutterIconSize: 'contain',
    });
    add('status-running', {
      gutterIconPath: this._icon('running'),
      gutterIconSize: 'contain',
    });
    add('status-pending', {
      gutterIconPath: this._icon('pending'),
      gutterIconSize: 'contain',
    });
    add('status-skipped', {
      gutterIconPath: this._icon('pending'),
      gutterIconSize: 'contain',
    });
  }
}
