import * as vscode from 'vscode';

/** Scope of the current selection. */
export type SelectionScope = 'file' | 'suite' | 'test';

/**
 * Lightweight selection model — identifies the currently selected item.
 * The `nodeId` references a TestNode in the ResultStore's flat node pool.
 * When nodeId is undefined, the entire file is selected.
 */
export interface Selection {
  scope: SelectionScope;
  fileId: string;
  nodeId?: string;
}

/**
 * SelectionState — shared selection model for sidebar and panel.
 *
 * When the user clicks a row in the sidebar or panel, the webview posts
 * a 'select' message which calls `select()` here. That broadcasts the
 * new state to all registered webviews via postMessage.
 */
export class SelectionState {
  private _current: Selection | null = null;
  private readonly _webviews = new Set<vscode.Webview>();

  get(): Selection | null {
    return this._current;
  }

  register(webview: vscode.Webview): void {
    this._webviews.add(webview);
  }

  unregister(webview: vscode.Webview): void {
    this._webviews.delete(webview);
  }

  select(sel: Selection): void {
    this._current = sel;
    for (const wv of this._webviews) {
      wv.postMessage({ type: 'scope-changed', ...sel });
    }
  }
}
