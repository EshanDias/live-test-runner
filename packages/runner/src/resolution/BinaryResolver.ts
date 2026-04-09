import * as fs from 'fs';
import * as path from 'path';

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
      return userOverride.trim();
    }

    // 1. Local .bin/jest symlink (most projects)
    const localBin = path.join(projectRoot, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localBin) || fs.existsSync(localBin + '.cmd')) {
      return platformCmd(localBin);
    }

    // 2. Walk up to monorepo / workspace root
    const workspaceBin = this.findInParent(projectRoot);
    if (workspaceBin) return platformCmd(workspaceBin);

    // 3. Legacy jest.js path (older installs without .bin symlink)
    const legacyJs = path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');
    if (fs.existsSync(legacyJs)) {
      // Return the .js path directly; the caller will invoke it with `node`
      return legacyJs;
    }

    // 4. npx jest — last resort
    return platformCmd('npx');
  }

  /**
   * Returns true if the resolved binary is a .js file that must be invoked via `node`.
   * (Covers the legacy node_modules/jest/bin/jest.js path.)
   */
  static isNodeScript(binary: string): boolean {
    return binary.endsWith('.js');
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
