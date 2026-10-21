import * as fs from 'fs';
import * as path from 'path';

/**
 * Test runners resolve their root to the *real* path (Jest: rootDir via
 * `fs.realpathSync.native`), so they report — and only accept — file paths
 * spelled that way. VS Code keeps
 * the path the folder was opened by, which can differ:
 *  - macOS: the temp folder /var/folders/… is a symlink to /private/var/…;
 *    any checkout opened through a symlink differs the same way.
 *  - Windows: 8.3 short names — C:\Users\RUNNER~1\… is C:\Users\runneradmin\…
 *    (GitHub's Windows runners, and %TEMP% for long user names) — plus
 *    junctions and subst drives.
 * Without translation, every file Jest lists or reports looks like an unknown
 * file, and every path we pass matches nothing ("No files found").
 *
 * Each project root registers both spellings. Paths sent to Jest use the real
 * one (`toRunnerPath`), paths read back from Jest use the editor's
 * (`fromRunnerPath`). Roots whose spellings agree pass through unchanged. On
 * Windows, comparisons ignore case and slash direction; drive-letter case is
 * still normalised by `toJestPathArg`.
 */
interface RootSpelling { link: string; real: string }

const differingRoots: RootSpelling[] = [];
const checkedRoots = new Set<string>();
let windows = process.platform === 'win32';

/** Same path for comparison purposes (case- and slash-insensitive on Windows). */
function comparable(p: string): string {
  return windows ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : p;
}

/** Records a project root's real path if it differs from how it was given. */
export function registerProjectRoot(
  root: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): void {
  if (!root) { return; }
  const link = windows ? path.win32.resolve(root) : path.resolve(root);
  const key = comparable(link);
  if (checkedRoots.has(key)) { return; }
  checkedRoots.add(key);
  let real: string;
  try {
    real = realpath(link);
  } catch {
    return; // missing folder — nothing to translate
  }
  if (comparable(real) === key) { return; }
  differingRoots.push({ link, real });
  // Longest first, so nested roots win over their parents.
  differingRoots.sort((a, b) => b.link.length - a.link.length);
}

/** Editor spelling → the runner's (real) spelling. */
export function toRunnerPath(filePath: string): string {
  for (const r of differingRoots) {
    const p = swapPrefix(filePath, r.link, r.real);
    if (p !== undefined) { return p; }
  }
  return filePath;
}

/** The runner's (real) spelling → editor spelling. */
export function fromRunnerPath(filePath: string): string {
  for (const r of differingRoots) {
    const p = swapPrefix(filePath, r.real, r.link);
    if (p !== undefined) { return p; }
  }
  return filePath;
}

/**
 * One spelling for every path handed to a runner that does not realpath
 * anything itself (Vitest): its CLI entry, cwd, config and file filters.
 * Vitest loads its own CLI from the path it was started by and the `vitest`
 * import in test files from where Node resolves it — if the two are spelled
 * differently (8.3 short name, drive-letter case), it runs two copies of
 * itself and the tests register with the wrong one ("no tests"). Node's
 * `require.resolve` keeps 8.3 names, so the native realpath is used here,
 * with an upper-case drive letter. Paths that do not exist fall back to
 * `toRunnerPath`.
 */
export function toSpawnPath(
  p: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): string {
  let real: string;
  try {
    real = realpath(p);
  } catch {
    real = toRunnerPath(p);
  }
  return windows ? real.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`) : real;
}

/** @deprecated Use toRunnerPath — kept for one release. */
export const toJestPath = toRunnerPath;
/** @deprecated Use fromRunnerPath — kept for one release. */
export const fromJestPath = fromRunnerPath;

function swapPrefix(p: string, from: string, to: string): string | undefined {
  const cp = comparable(p);
  const cf = comparable(from);
  if (cp === cf) { return to; }
  // On Windows `comparable` only changes case and slashes, so lengths match
  // and the rest of `p` keeps its own spelling.
  const sep = windows ? '/' : path.sep;
  if (cp.startsWith(cf + sep)) { return to + p.slice(cf.length); }
  return undefined;
}

/** For tests only: forget registered roots; optionally pretend to be (not) Windows. */
export function _resetProjectRoots(asWindows: boolean = process.platform === 'win32'): void {
  differingRoots.length = 0;
  checkedRoots.clear();
  windows = asWindows;
}
