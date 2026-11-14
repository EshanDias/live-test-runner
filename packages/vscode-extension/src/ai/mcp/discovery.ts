/**
 * Which editor window an MCP relay talks to.
 *
 * Started by the editor (Cursor's registration): the window's session
 * folder comes in `LTR_SESSION_DIR` — exact, nothing to guess. Started by a
 * terminal agent: every open window announces itself with a `bridge.json`
 * in its session folder (and a pointer in the extension's storage folder,
 * in case the agent's temp folder differs from the editor's); the relay
 * takes the window whose workspace contains the agent's folder, newest
 * first. A window is open while its pid is alive and its bridge.json is
 * still there with the same start time (a reused pid fails that check).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BRIDGE_FILE, BASE_TMP_DIR, BridgeInfo, isProcessAlive, readJson } from '../protocol';

export interface WindowChoice {
  /** The window to talk to, if one fits. */
  chosen?: BridgeInfo;
  /** Other open windows (shown by LTR_get_status, and in the "no window" answer). */
  others: BridgeInfo[];
}

export interface DiscoveryOptions {
  /** The agent's folder (its cwd, or LTR_WORKSPACE). */
  workspace: string;
  /** LTR_SESSION_DIR: an exact window. */
  sessionDir?: string;
  /** Folders of window pointers (the launcher's `windows/`). */
  pointerDirs?: string[];
  /** The temp root with `session-*` folders. */
  tmpRoot?: string;
}

/** A window is still open: its pid lives and its bridge.json is the one we read. */
export function isOpen(info: BridgeInfo): boolean {
  if (!info || typeof info.pid !== 'number' || !isProcessAlive(info.pid)) { return false; }
  const current = readJson<BridgeInfo>(path.join(info.sessionDir, BRIDGE_FILE));
  return !!current && current.startedAt === info.startedAt && current.pid === info.pid;
}

/** Every open window that announced itself. */
export function openWindows(opts: Pick<DiscoveryOptions, 'pointerDirs' | 'tmpRoot'>): BridgeInfo[] {
  const found = new Map<string, BridgeInfo>();
  const consider = (info: BridgeInfo | undefined) => {
    if (info && typeof info.sessionDir === 'string' && !found.has(info.sessionDir) && isOpen(info)) { found.set(info.sessionDir, info); }
  };
  const tmpRoot = opts.tmpRoot ?? BASE_TMP_DIR;
  try {
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (entry.startsWith('session-')) { consider(readJson<BridgeInfo>(path.join(tmpRoot, entry, BRIDGE_FILE))); }
    }
  } catch { /* no windows yet */ }
  for (const dir of opts.pointerDirs ?? []) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.json')) { consider(readJson<BridgeInfo>(path.join(dir, entry))); }
      }
    } catch { /* none */ }
  }
  return [...found.values()];
}

/** How closely a window's folders match the agent's: 2 = the agent is inside one, 1 = one is inside the agent's folder, 0 = neither. */
function fit(info: BridgeInfo, workspace: string): number {
  const inside = (child: string, parent: string) => {
    const r = path.relative(parent, child);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const ws = norm(workspace);
  let best = 0;
  for (const root of info.workspaceRoots ?? []) {
    const r = norm(root);
    if (inside(ws, r)) { best = 2; } else if (inside(r, ws)) { best = Math.max(best, 1); }
  }
  return best;
}

function norm(p: string): string {
  let r = p;
  try { r = fs.realpathSync.native(p); } catch { /* as given */ }
  return process.platform === 'linux' ? r : r.toLowerCase();
}

export function chooseWindow(opts: DiscoveryOptions): WindowChoice {
  if (opts.sessionDir) {
    const info = readJson<BridgeInfo>(path.join(opts.sessionDir, BRIDGE_FILE));
    if (info && isOpen(info)) { return { chosen: info, others: [] }; }
  }
  const windows = openWindows(opts);
  const ranked = windows
    .map((w) => ({ w, f: fit(w, opts.workspace) }))
    .filter((x) => x.f > 0)
    .sort((a, b) => b.f - a.f || b.w.startedAt - a.w.startedAt);
  const chosen = ranked[0]?.w;
  return { chosen, others: windows.filter((w) => w !== chosen) };
}
