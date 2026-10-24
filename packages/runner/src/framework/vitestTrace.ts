import * as fs from 'fs';
import * as path from 'path';
import { resolvePackageDir } from '../resolution/BinaryResolver';

/**
 * Helpers for Vitest's execution trace (the extension's wrapper config):
 * where the project's own Vitest and Vite live. The wrapper loads the
 * project's config with that Vite (`loadConfigFromFile`, `mergeConfig`), so
 * it behaves exactly as Vitest's own loading does.
 */

/** The real folder of the Vitest the project resolves (pnpm: inside its store). */
export function vitestDirFor(projectRoot: string): string | undefined {
  const dir = resolvePackageDir('vitest', projectRoot);
  if (!dir) { return undefined; }
  try { return fs.realpathSync(dir); } catch { return dir; }
}

/**
 * Absolute path of Vite's ESM entry as the project's Vitest resolves it
 * (`exports['.'].import`, a string, or `{ import: { default } }`), or
 * undefined when it cannot be found.
 */
export function viteEntryFor(projectRoot: string): string | undefined {
  const vitestDir = vitestDirFor(projectRoot);
  if (!vitestDir) { return undefined; }
  const viteDir = resolvePackageDir('vite', vitestDir);
  if (!viteDir) { return undefined; }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(viteDir, 'package.json'), 'utf8')) as { exports?: Record<string, unknown>; module?: string };
    const rel = esmEntry(pkg.exports?.['.']) ?? pkg.module;
    if (!rel) { return undefined; }
    const file = path.join(viteDir, rel);
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The ESM file of one `exports` entry. */
export function esmEntry(e: unknown): string | undefined {
  if (typeof e === 'string') { return e; }
  if (!e || typeof e !== 'object') { return undefined; }
  const o = e as Record<string, unknown>;
  for (const key of ['import', 'default', 'node']) {
    const v = o[key];
    const found = typeof v === 'string' ? v : esmEntry(v);
    if (found) { return found; }
  }
  return undefined;
}
