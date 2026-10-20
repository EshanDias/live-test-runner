import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const log = createLogger('BinaryResolver');

/**
 * Resolves the Jest binary for standard (non-CRA) projects.
 *
 * Resolution priority:
 *  1. User-provided command override (from VS Code settings)
 *  2. Jest's JS entry point (`jest/bin/jest.js`) resolved from the project the
 *     way Node would — covers local installs, monorepo hoisting and pnpm.
 *     It is run with `node` directly, never through a shell.
 *  3. node_modules/.bin/jest in the project or a parent folder
 *  4. npx jest  (last resort — may fail in restricted CI environments)
 *
 * Why not `.bin/jest.cmd` on Windows: `.cmd` shims must run through cmd.exe,
 * which splits paths containing spaces, strips `^`, and treats `|` as a pipe —
 * so test-name patterns arrived mangled and killing the shell left Jest running.
 */
export class BinaryResolver {
  /**
   * @param userOverride  Optional path/command from the user's settings.
   *                      When provided, it is returned immediately (the user knows best).
   */
  resolve(projectRoot: string, userOverride?: string): string {
    if (userOverride?.trim()) {
      log.trace(`Using jest command override: ${userOverride.trim()}`);
      return userOverride.trim();
    }

    const entry = BinaryResolver.resolveJestEntry(projectRoot);
    if (entry) {
      log.trace(`Jest entry point: ${entry}`);
      return entry;
    }

    // Jest is not resolvable as a package — fall back to a .bin shim.
    const localBin = path.join(projectRoot, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localBin) || fs.existsSync(localBin + '.cmd')) {
      const resolved = platformCmd(localBin);
      log.trace(`Jest binary (local .bin): ${resolved}`);
      return resolved;
    }
    const workspaceBin = this.findInParent(projectRoot);
    if (workspaceBin) {
      const resolved = platformCmd(workspaceBin);
      log.trace(`Jest binary (parent .bin): ${resolved}`);
      return resolved;
    }

    log.warn(`No local Jest install found under ${projectRoot} — falling back to "npx jest" (slower, may download Jest)`);
    return platformCmd('npx');
  }

  /**
   * Absolute path to Jest's JS entry point as seen from `fromDir`, or undefined.
   * Resolved through `<pkg>/package.json` because Jest's `exports` map does not
   * expose `bin/jest.js` itself.
   */
  static resolveJestEntry(fromDir: string): string | undefined {
    for (const pkgName of JEST_PACKAGES) {
      const entry = resolvePackageBin(pkgName, fromDir);
      if (entry) { return entry; }
    }
    return undefined;
  }

  /**
   * Jest entry point for a Create React App project: the Jest that react-scripts
   * depends on (often a different major version than any project-level Jest),
   * falling back to whatever the project resolves.
   */
  static resolveCraJestEntry(projectRoot: string): string | undefined {
    const reactScriptsDir = resolvePackageDir('react-scripts', projectRoot);
    if (reactScriptsDir) {
      const entry = BinaryResolver.resolveJestEntry(reactScriptsDir);
      if (entry) { return entry; }
    }
    return BinaryResolver.resolveJestEntry(projectRoot);
  }

  /**
   * Returns true if the resolved binary is a .js file that must be invoked via `node`.
   */
  static isNodeScript(binary: string): boolean {
    if (/\.(c|m)?js$/i.test(binary)) { return true; }
    // On macOS/Linux, .bin/jest is a symlink to the actual .js entry point.
    // Follow the symlink so we can invoke it via node instead of relying on
    // the shebang (which fails when node isn't in PATH).
    try {
      const real = fs.realpathSync(binary);
      if (/\.(c|m)?js$/i.test(real)) { return true; }
    } catch (err) {
      // Expected for bare commands such as "npx" that are not file paths.
      log.trace(`realpath failed for ${binary}: ${(err as NodeJS.ErrnoException).message}`);
    }
    return false;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private findInParent(startDir: string): string | undefined {
    let dir = path.dirname(startDir);
    const root = path.parse(dir).root;

    while (dir !== root) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'jest');
      if (fs.existsSync(candidate) || fs.existsSync(candidate + '.cmd')) {
        return candidate;
      }
      dir = path.dirname(dir);
    }

    return undefined;
  }
}

/** Packages that ship the `jest` CLI, in preference order. */
const JEST_PACKAGES = ['jest', 'jest-cli'];

function resolvePackageDir(pkgName: string, fromDir: string): string | undefined {
  try {
    // Non-literal id so bundlers leave this require.resolve alone.
    const pkgJson = require.resolve(`${pkgName}/package.json`, { paths: [fromDir] });
    return path.dirname(pkgJson);
  } catch {
    return undefined;
  }
}

function resolvePackageBin(pkgName: string, fromDir: string): string | undefined {
  const dir = resolvePackageDir(pkgName, fromDir);
  if (!dir) { return undefined; }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jest;
    const candidate = path.join(dir, rel ?? path.join('bin', 'jest.js'));
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

// ── Node runtime ───────────────────────────────────────────────────────────────

export interface NodeRuntime {
  /** Absolute path of the node executable. */
  binary: string;
  /** Extra environment needed to run it as plain Node. */
  env: Record<string, string>;
}

let _nodeRuntime: NodeRuntime | undefined;

/**
 * The Node executable used to run Jest's JS entry point.
 *
 * Prefers `node` from PATH — the same Node `npm test` uses, so native addons
 * built for it keep working. Falls back to the editor's own runtime (Electron
 * in Node mode) when no node is on PATH, e.g. VS Code launched from the macOS
 * Dock without a shell environment.
 */
export function nodeRuntime(): NodeRuntime {
  if (_nodeRuntime) { return _nodeRuntime; }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      if (fs.statSync(candidate).isFile()) {
        log.debug(`Running Jest with ${candidate}`);
        return (_nodeRuntime = { binary: candidate, env: {} });
      }
    } catch { /* not here */ }
  }
  log.warn(`No "node" on PATH — running Jest with the editor's built-in Node (${process.execPath})`);
  return (_nodeRuntime = { binary: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
}

// ── Shared platform helper ─────────────────────────────────────────────────────

export function platformCmd(bin: string): string {
  if (process.platform === 'win32') {
    const lower = bin.toLowerCase();
    if (!lower.endsWith('.cmd') && !lower.endsWith('.exe')) return `${bin}.cmd`;
  }
  return bin;
}
