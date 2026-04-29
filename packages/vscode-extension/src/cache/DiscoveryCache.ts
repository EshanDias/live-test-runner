import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

const FILE = 'DiscoveryCache.ts';

const CACHE_VERSION  = 1;
const MAX_PROJECTS   = 10;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB

// ── Types ──────────────────────────────────────────────────────────────────────

export type DiscoveryResult = {
  suites: Array<{
    name: string;
    line: number;
    tests: Array<{ name: string; line: number; fullName: string }>;
    children: Array<any>;
    isSharedVars: boolean;
    sharedVarNames: string[];
  }>;
  rootTests: Array<{ name: string; line: number; fullName: string }>;
};

type CacheEntry = {
  mtime: number;
  result: DiscoveryResult;
};

type CacheFile = {
  version: number;
  createdAt: number;
  lastUsedAt: number;
  entries: Record<string, CacheEntry>;
};

type ProjectInfo = {
  dir: string;
  lastUsedAt: number;
  sizeBytes: number;
  isActive: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

function dirSizeBytes(dirPath: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile()) {
        try { total += fs.statSync(path.join(dirPath, entry.name)).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

function readLockPid(lockPath: string): number | null {
  try {
    return parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) || null;
  } catch {
    return null;
  }
}

// ── CapacityResult ─────────────────────────────────────────────────────────────

export type CapacityResult =
  | { ok: true }
  | { ok: false; totalMb: number; activeCount: number };

// ── DiscoveryCache ─────────────────────────────────────────────────────────────

/**
 * Per-project persistent cache for test discovery results (Babel AST parse output).
 *
 * Each file entry stores the parsed result alongside its mtime. On load, stale
 * entries (mtime changed or file deleted) are dropped; only changed files are
 * re-parsed by TestDiscoveryService.
 *
 * Cache dir layout:
 *   <cacheRootDir>/<folderName>-<hash8>/
 *     discovery-cache.json   — per-file mtime + parsed test tree
 *     session.lock           — current VS Code PID (live session indicator)
 */
export class DiscoveryCache {
  private readonly _cacheDir: string;
  private readonly _cacheFilePath: string;
  private readonly _lockFilePath: string;
  private _data: CacheFile;
  private _dirty = false;

  constructor(cacheRootDir: string, workspacePath: string) {
    const folderName = path.basename(workspacePath);
    const hash       = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 8);
    const projectKey = `${folderName}-${hash}`;

    this._cacheDir      = path.join(cacheRootDir, projectKey);
    this._cacheFilePath = path.join(this._cacheDir, 'discovery-cache.json');
    this._lockFilePath  = path.join(this._cacheDir, 'session.lock');

    try { fs.mkdirSync(this._cacheDir, { recursive: true }); } catch { /* ignore */ }

    this._data = this._loadFromDisk();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Returns the cached discovery result for a file if the mtime still matches.
   * Returns null on any cache miss, stale entry, or missing file.
   */
  get(filePath: string): DiscoveryResult | null {
    const entry = this._data.entries[filePath];
    if (!entry) { return null; }

    try {
      const { mtimeMs } = fs.statSync(filePath);
      if (mtimeMs !== entry.mtime) {
        delete this._data.entries[filePath];
        this._dirty = true;
        return null;
      }
      return entry.result;
    } catch {
      delete this._data.entries[filePath];
      this._dirty = true;
      return null;
    }
  }

  /** Store a parsed result alongside the file's current mtime. */
  set(filePath: string, mtime: number, result: DiscoveryResult): void {
    this._data.entries[filePath] = { mtime, result };
    this._dirty = true;
  }

  /** Persist any dirty entries to disk. Call after a discovery pass completes. */
  flush(): void {
    if (!this._dirty) { return; }
    try {
      this._data.lastUsedAt = Date.now();
      fs.writeFileSync(this._cacheFilePath, JSON.stringify(this._data), 'utf8');
      this._dirty = false;
    } catch (err) {
      logger.warn(FILE, 'flush', 'Failed to write discovery cache', err);
    }
  }

  /** Write a PID lock so rotation skips this project while the session is live. */
  writeLock(): void {
    try { fs.writeFileSync(this._lockFilePath, String(process.pid), 'utf8'); } catch { /* ignore */ }
  }

  /** Remove the PID lock when the session ends or the extension deactivates. */
  releaseLock(): void {
    try { fs.unlinkSync(this._lockFilePath); } catch { /* ignore */ }
  }

  /**
   * Delete this project's entire cache directory and reset in-memory state.
   * Called by "Clear Cache and Restart Testing" and Shift+Stop.
   */
  clear(): void {
    try { fs.rmSync(this._cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this._data  = { version: CACHE_VERSION, createdAt: Date.now(), lastUsedAt: Date.now(), entries: {} };
    this._dirty = false;
    // Re-create the dir so the lock file can be written again immediately.
    try { fs.mkdirSync(this._cacheDir, { recursive: true }); } catch { /* ignore */ }
  }

  get cacheDir(): string { return this._cacheDir; }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _loadFromDisk(): CacheFile {
    try {
      if (!fs.existsSync(this._cacheFilePath)) {
        return _emptyCache();
      }
      const raw = JSON.parse(fs.readFileSync(this._cacheFilePath, 'utf8')) as CacheFile;
      if (raw.version !== CACHE_VERSION) { return _emptyCache(); }
      return raw;
    } catch {
      return _emptyCache();
    }
  }
}

function _emptyCache(): CacheFile {
  return { version: CACHE_VERSION, createdAt: Date.now(), lastUsedAt: Date.now(), entries: {} };
}

// ── Cache rotation (called at Start Testing time) ─────────────────────────────

/**
 * Scans all project cache dirs under cacheRootDir.
 * Evicts inactive (no live PID lock) LRU projects when:
 *   - total size > 500 MB and more than 1 project is cached
 *   - more than MAX_PROJECTS are cached
 *
 * Returns `{ ok: false }` with stats if eviction was impossible (all sessions
 * active and still over cap) so the caller can show a warning to the user.
 * Returns `{ ok: true }` when within limits or only one project exists.
 */
export function rotateAndCheckCapacity(cacheRootDir: string): CapacityResult {
  const cacheRoot = cacheRootDir;
  if (!fs.existsSync(cacheRoot)) { return { ok: true }; }

  // Build project list
  const projects: ProjectInfo[] = [];
  try {
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) { continue; }
      const dir      = path.join(cacheRoot, entry.name);
      const lockPath = path.join(dir, 'session.lock');
      const pid      = readLockPid(lockPath);
      const isActive = pid !== null && isProcessAlive(pid);
      let lastUsedAt = 0;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'discovery-cache.json'), 'utf8'));
        lastUsedAt = manifest.lastUsedAt ?? 0;
      } catch { /* project may have no cache yet */ }
      projects.push({ dir, lastUsedAt, sizeBytes: dirSizeBytes(dir), isActive });
    }
  } catch (err) {
    logger.warn(FILE, 'rotateAndCheckCapacity', 'Failed to scan cache root', err);
    return { ok: true };
  }

  // Single project: no cap enforced
  if (projects.length <= 1) { return { ok: true }; }

  const totalBytes  = () => projects.reduce((s, p) => s + p.sizeBytes, 0);
  const activeCount = () => projects.filter(p => p.isActive).length;

  // Evict inactive projects — oldest first — until within limits
  const inactive = projects
    .filter(p => !p.isActive)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  for (const p of inactive) {
    if (projects.length <= MAX_PROJECTS && totalBytes() <= MAX_TOTAL_BYTES) { break; }
    try {
      fs.rmSync(p.dir, { recursive: true, force: true });
      projects.splice(projects.indexOf(p), 1);
      logger.info(FILE, 'rotateAndCheckCapacity', `Evicted LRU cache: ${p.dir}`);
    } catch (err) {
      logger.warn(FILE, 'rotateAndCheckCapacity', `Failed to evict ${p.dir}`, err);
    }
  }

  if (projects.length > MAX_PROJECTS || totalBytes() > MAX_TOTAL_BYTES) {
    const mb = Math.round(totalBytes() / 1024 / 1024);
    return { ok: false, totalMb: mb, activeCount: activeCount() };
  }

  return { ok: true };
}
