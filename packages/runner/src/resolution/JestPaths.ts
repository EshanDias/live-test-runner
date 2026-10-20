import * as fs from 'fs';
import * as path from 'path';

/**
 * Jest resolves symlinks in its rootDir, so it reports — and only accepts —
 * file paths under the project's *real* path. VS Code keeps the path the
 * folder was opened by: on macOS the temp folder /var/folders/… is a link to
 * /private/var/folders/…, and any checkout opened through a symlink differs
 * the same way. Without translation, every file Jest lists or reports looks
 * like an unknown file, and every path we pass matches nothing.
 *
 * Each project root registers both spellings. Paths sent to Jest use the real
 * one (`toJestPath`), paths read back from Jest use the editor's
 * (`fromJestPath`). Unregistered or non-symlinked roots pass through unchanged.
 *
 * Windows is left alone: Jest's spelling there differs only in drive-letter
 * case, which `toJestPathArg` already handles.
 */
interface RootSpelling { link: string; real: string }

const symlinkedRoots: RootSpelling[] = [];
const checkedRoots = new Set<string>();

/** Records a project root's real path if it differs from how it was given. */
export function registerProjectRoot(root: string): void {
  if (process.platform === 'win32' || !root) { return; }
  const link = path.resolve(root);
  if (checkedRoots.has(link)) { return; }
  checkedRoots.add(link);
  let real: string;
  try {
    real = fs.realpathSync(link);
  } catch {
    return; // missing folder — nothing to translate
  }
  if (real === link) { return; }
  symlinkedRoots.push({ link, real });
  // Longest first, so nested roots win over their parents.
  symlinkedRoots.sort((a, b) => b.link.length - a.link.length);
}

/** Editor spelling → Jest's (real) spelling. */
export function toJestPath(filePath: string): string {
  for (const r of symlinkedRoots) {
    const p = swapPrefix(filePath, r.link, r.real);
    if (p !== undefined) { return p; }
  }
  return filePath;
}

/** Jest's (real) spelling → editor spelling. */
export function fromJestPath(filePath: string): string {
  for (const r of symlinkedRoots) {
    const p = swapPrefix(filePath, r.real, r.link);
    if (p !== undefined) { return p; }
  }
  return filePath;
}

function swapPrefix(p: string, from: string, to: string): string | undefined {
  if (p === from) { return to; }
  if (p.startsWith(from + path.sep)) { return to + p.slice(from.length); }
  return undefined;
}

/** For tests only. */
export function _resetProjectRoots(): void {
  symlinkedRoots.length = 0;
  checkedRoots.clear();
}
