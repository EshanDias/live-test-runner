/**
 * Tells file changes made outside the editor (git pull, a branch switch, a
 * code generator) from the editor's own saves, and hands them over in
 * batches. No VS Code dependency.
 */

/** A file-system event this soon after the editor saved the file is that save, not an outside change. */
export const SAVE_ECHO_MS = 2_000;
/** Changes are collected this long, so a branch switch arrives as one batch. */
export const BATCH_MS = 500;

const IGNORED = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

export interface ExternalChangesOptions {
  /** Called with each batch of files changed outside the editor. */
  onChanged: (filePaths: string[]) => void;
  /** The file is open with unsaved edits (the editor will ask the user; nothing reruns). */
  isDirtyInEditor: (filePath: string) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ExternalChanges {
  private readonly _savedAt = new Map<string, number>();
  private readonly _pending = new Set<string>();
  private _timer: unknown;
  private readonly _now: () => number;
  private readonly _setTimer: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimer: (handle: unknown) => void;

  constructor(private readonly _opts: ExternalChangesOptions) {
    this._now = _opts.now ?? Date.now;
    this._setTimer = _opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = _opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** The editor saved this file (its file-system event that follows is not an outside change). */
  noteSave(filePath: string): void {
    this._savedAt.set(key(filePath), this._now());
  }

  /** A file was created or changed on disk. */
  fileChanged(filePath: string): void {
    if (IGNORED.test(filePath)) { return; }
    const k = key(filePath);
    const saved = this._savedAt.get(k);
    if (saved !== undefined && this._now() - saved < SAVE_ECHO_MS) { return; }
    if (this._opts.isDirtyInEditor(filePath)) { return; }
    this._pending.add(filePath);
    if (this._timer !== undefined) { this._clearTimer(this._timer); }
    this._timer = this._setTimer(() => this._flush(), BATCH_MS);
  }

  dispose(): void {
    if (this._timer !== undefined) { this._clearTimer(this._timer); }
    this._pending.clear();
  }

  private _flush(): void {
    this._timer = undefined;
    const files = [...this._pending];
    this._pending.clear();
    const cutoff = this._now() - SAVE_ECHO_MS;
    for (const [k, t] of this._savedAt) { if (t < cutoff) { this._savedAt.delete(k); } }
    if (files.length > 0) { this._opts.onChanged(files); }
  }
}

function key(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
