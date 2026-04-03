import * as vscode from 'vscode';

export type SelectionScope = 'file' | 'suite' | 'test';

export interface Selection {
  scope: SelectionScope;
  fileId: string;
  suiteId?: string;
  testId?: string;
}

type WebviewLike = { postMessage(msg: unknown): Thenable<boolean> };

/**
 * SelectionState — tracks the currently selected test scope and broadcasts
 * scope-changed messages to all registered webviews when it changes.
 */
export class SelectionState {
  private current: Selection | undefined;
  private webviews: Set<WebviewLike> = new Set();

  register(webview: WebviewLike): void {
    this.webviews.add(webview);
  }

  unregister(webview: WebviewLike): void {
    this.webviews.delete(webview);
  }

  /** Called by extension when a webview posts a 'select' message. */
  select(selection: Selection): void {
    this.current = selection;
    this.broadcast({ type: 'scope-changed', ...selection });
  }

  get(): Selection | undefined {
    return this.current;
  }

  clear(): void {
    this.current = undefined;
  }

  private broadcast(msg: unknown): void {
    for (const wv of this.webviews) {
      wv.postMessage(msg).then(undefined, (err: unknown) => {
        console.error('[LiveTestRunner] SelectionState broadcast failed:', err);
      });
    }
  }
}
