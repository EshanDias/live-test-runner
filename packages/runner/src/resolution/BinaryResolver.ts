import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const log = createLogger('BinaryResolver');

/**
 * Resolves the Jest binary for standard (non-CRA) projects.
 *
 * Resolution priority:
 *  1. User-provided command override (from VS Code settings)
 *  2. node_modules/.bin/jest  (local install — the expected case)
 *  3. Walk up the directory tree to the workspace/monorepo root
 *  4. node_modules/jest/bin/jest.js  (legacy path)
 *  5. npx jest  (last resort — may fail in restricted CI environments)
 *
 * All resolution happens against the project's own node_modules.
 * Global binaries are never assumed.
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

    // 1. Local .bin/jest symlink (most projects)
    const localBin = path.join(projectRoot, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localBin) || fs.existsSync(localBin + '.cmd')) {
      const resolved = platformCmd(localBin);
      log.trace(`Jest binary (local): ${resolved}`);
      return resolved;
    }

    // 2. Walk up to monorepo / workspace root
    const workspaceBin = this.findInParent(projectRoot);
    if (workspaceBin) {
      const resolved = platformCmd(workspaceBin);
      log.trace(`Jest binary (parent workspace): ${resolved}`);
      return resolved;
    }

    // 3. Legacy jest.js path (older installs without .bin symlink)
    const legacyJs = path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');
    if (fs.existsSync(legacyJs)) {
      log.trace(`Jest binary (legacy jest.js): ${legacyJs}`);
      // Return the .js path directly; the caller will invoke it with `node`
      return legacyJs;
    }

    // 4. npx jest — last resort
    log.warn(`No local Jest install found under ${projectRoot} — falling back to "npx jest" (slower, may download Jest)`);
    return platformCmd('npx');
  }

  /**
   * Returns true if the resolved binary is a .js file that must be invoked via `node`.
   * (Covers the legacy node_modules/jest/bin/jest.js path.)
   */
  static isNodeScript(binary: string): boolean {
    if (binary.endsWith('.js')) { return true; }
    // On macOS/Linux, .bin/jest is a symlink to the actual .js entry point.
    // Follow the symlink so we can invoke it via process.execPath instead of
    // relying on the shebang (which fails when node isn't in PATH).
    try {
      const real = fs.realpathSync(binary);
      if (real.endsWith('.js')) { return true; }
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

// ── Shared platform helper ─────────────────────────────────────────────────────

export function platformCmd(bin: string): string {
  if (process.platform === 'win32') {
    const lower = bin.toLowerCase();
    if (!lower.endsWith('.cmd') && !lower.endsWith('.exe')) return `${bin}.cmd`;
  }
  return bin;
}
