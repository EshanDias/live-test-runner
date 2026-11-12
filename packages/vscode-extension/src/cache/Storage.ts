/**
 * Everything Live Test Runner keeps on disk, in one place, so it can be
 * cleared per project, cleared entirely, and pruned when unused.
 *
 *   <cache dir>/com.eshLabs/live-test-runner/          (kept across restarts)
 *     <folder>-<hash8>/                 discovery cache (DiscoveryCache) + session.lock
 *     ltr-cra-config-<hash>.json        a Create React App project's extracted Jest config
 *   <temp dir>/com.eshLabs/live-test-runner/
 *     session-<pid>-<time>/             one VS Code window's session (removed when the window is gone)
 *     runnable-files-<hash16>.json      the framework's list of runnable test files
 *     vitest-config-<hash16>.json       what the Vitest config probe read (projects, coverage include, workers)
 *     transform-cache-<hash>/           Jest transform cache + coverage manifests
 *
 * The user's Python interpreter choice is kept in VS Code's workspace state, not here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { craConfigPath, LTR_BASE_CACHE_DIR, LTR_BASE_TMP_DIR, vitestConfigCachePath } from '@live-test-runner/runner';
import { runnableFilesPath as runnablePath } from '../session/RunnableFiles';

/** Cached data not used for this long is deleted when VS Code starts. */
export const UNUSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The Jest transform cache (and coverage manifests) of a project, kept across sessions. */
export function transformCacheDir(projectRoot: string, tmpDir = LTR_BASE_TMP_DIR): string {
  let h = 5381;
  for (let i = 0; i < projectRoot.length; i++) { h = ((h << 5) + h) ^ projectRoot.toLowerCase().charCodeAt(i); }
  return path.join(tmpDir, `transform-cache-${(h >>> 0).toString(36)}`);
}

/** The remembered runnable-files list of a project. */
export function runnableFilesPath(projectRoot: string, tmpDir = LTR_BASE_TMP_DIR): string {
  return runnablePath(projectRoot, tmpDir);
}

/** Marks a cache entry as used now (pruning goes by last use). */
export function touch(p: string): void {
  const now = new Date();
  try { fs.utimesSync(p, now, now); } catch { /* not there yet */ }
}

/**
 * Deletes a project's cached files outside its discovery cache (which
 * DiscoveryCache.clear() empties while keeping its lock).
 * @returns how many entries were removed
 */
export function clearProjectCaches(projectRoot: string): number {
  let removed = 0;
  for (const p of [runnableFilesPath(projectRoot), transformCacheDir(projectRoot), craConfigPath(projectRoot), vitestConfigCachePath(projectRoot, LTR_BASE_TMP_DIR)]) {
    if (fs.existsSync(p)) {
      try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch { /* in use — next time */ }
    }
  }
  return removed;
}

export interface ClearAllOptions {
  /** This window's session folder (emptied, not removed). */
  ownSessionDir: string;
  isProcessAlive: (pid: number) => boolean;
  cacheDir?: string;
  tmpDir?: string;
}

/**
 * Deletes every cached file, except what another open VS Code window is
 * using right now: its session folder and its locked discovery caches. This
 * window's own discovery caches are emptied by the caller (DiscoveryCache.clear).
 * @returns how many entries were removed
 */
export function clearAll(opts: ClearAllOptions): number {
  const cacheDir = opts.cacheDir ?? LTR_BASE_CACHE_DIR;
  const tmpDir = opts.tmpDir ?? LTR_BASE_TMP_DIR;
  let removed = 0;
  const rm = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch { /* in use */ } };

  for (const name of list(tmpDir)) {
    const full = path.join(tmpDir, name);
    const session = /^session-(\d+)-/.exec(name);
    if (session) {
      if (path.resolve(full) === path.resolve(opts.ownSessionDir)) {
        for (const inner of list(full)) { rm(path.join(full, inner)); }
      } else if (!opts.isProcessAlive(Number(session[1]))) {
        rm(full);
      }
      continue;
    }
    rm(full);
  }

  for (const name of list(cacheDir)) {
    const full = path.join(cacheDir, name);
    const pid = lockPid(full);
    if (pid !== null && opts.isProcessAlive(pid)) { continue; } // a window has it open (this one: cleared by the caller)
    rm(full);
  }
  return removed;
}

export interface PruneOptions {
  isProcessAlive: (pid: number) => boolean;
  now?: number;
  maxAgeMs?: number;
  cacheDir?: string;
  tmpDir?: string;
}

/**
 * Deletes cached data no window has used for {@link UNUSED_MAX_AGE_MS}: a
 * project opened once is not kept forever. Locked (open) projects are kept.
 * @returns how many entries were removed
 */
export function pruneUnused(opts: PruneOptions): number {
  const cacheDir = opts.cacheDir ?? LTR_BASE_CACHE_DIR;
  const tmpDir = opts.tmpDir ?? LTR_BASE_TMP_DIR;
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? UNUSED_MAX_AGE_MS);
  let removed = 0;
  const old = (p: string) => { try { return fs.statSync(p).mtimeMs < cutoff; } catch { return false; } };
  const rm = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch { /* in use */ } };

  for (const name of list(tmpDir)) {
    if (/^(transform-cache-|runnable-files-|vitest-config-)/.test(name) && old(path.join(tmpDir, name))) { rm(path.join(tmpDir, name)); }
  }
  for (const name of list(cacheDir)) {
    const full = path.join(cacheDir, name);
    if (name.startsWith('ltr-cra-config-')) {
      if (old(full)) { rm(full); }
      continue;
    }
    const pid = lockPid(full);
    if (pid !== null && opts.isProcessAlive(pid)) { continue; }
    if (lastUsed(full) < cutoff) { rm(full); }
  }
  return removed;
}

function list(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function lockPid(dir: string): number | null {
  try { return parseInt(fs.readFileSync(path.join(dir, 'session.lock'), 'utf8').trim(), 10) || null; } catch { return null; }
}

/** A discovery cache folder's last use: its manifest's lastUsedAt, else the folder's mtime. */
function lastUsed(dir: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'discovery-cache.json'), 'utf8')) as { lastUsedAt?: number };
    if (typeof data.lastUsedAt === 'number') { return data.lastUsedAt; }
  } catch { /* no manifest */ }
  try { return fs.statSync(dir).mtimeMs; } catch { return Date.now(); }
}
