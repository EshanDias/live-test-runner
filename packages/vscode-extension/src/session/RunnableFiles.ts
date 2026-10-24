/**
 * RunnableFiles — remembers the answer to `jest --listTests` between sessions.
 *
 * Asking Jest which files its config runs costs a full Jest startup (20 s on
 * a 200-file Create React App project), and every Start waited for it before
 * the first test ran. The answer only changes when a test file is added or
 * removed or the Jest config changes, so it is kept per project under a key
 * made of exactly those inputs: any change asks Jest again.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fromRunnerPath, VITEST_CONFIG_FILES, VITE_CONFIG_FILES } from '@live-test-runner/runner';

/** Files in the project root that can change which tests Jest runs. */
const CONFIG_FILES = [
  'package.json',
  'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
  'jest.config.ts', 'jest.config.cts', 'jest.config.mts',
  'jest.config.json',
];

/**
 * Config files of other frameworks (Vitest). They count only when present,
 * so adding them did not change the key — and the remembered list — of
 * existing Jest projects.
 */
const OPTIONAL_CONFIG_FILES = [...VITEST_CONFIG_FILES, ...VITE_CONFIG_FILES];

/**
 * Comparable spelling of a path: the editor's spelling (lists remembered by
 * older versions hold Jest's realpath'd spelling), case-insensitive on Windows.
 */
export function runnableKey(filePath: string): string {
  const p = path.normalize(fromRunnerPath(filePath));
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Key for one project's list: the discovered test files, the config files'
 * size and modification time, and the extension settings that change how
 * Jest is called.
 */
export function runnableCacheKey(projectRoot: string, testFiles: string[], settings: string): string {
  const h = crypto.createHash('sha256');
  h.update(settings).update('\0');
  for (const name of CONFIG_FILES) {
    let stamp = '-';
    try {
      const st = fs.statSync(path.join(projectRoot, name));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch { /* not there */ }
    h.update(`${name}=${stamp}\0`);
  }
  for (const name of OPTIONAL_CONFIG_FILES) {
    try {
      const st = fs.statSync(path.join(projectRoot, name));
      h.update(`${name}=${st.size}:${st.mtimeMs}\0`);
    } catch { /* not there — leaves the key unchanged */ }
  }
  for (const f of testFiles.map(runnableKey).sort()) { h.update(f).update('\0'); }
  return h.digest('hex');
}

/** One remembered answer. */
export interface RunnableEntry {
  files: string[];
  groups?: Record<string, string>;
  /** Mixed projects: file → `"<framework>:<rule>"`. */
  frameworks?: Record<string, string>;
}

export class RunnableFilesCache {
  /** @param _dir folder shared by all sessions (survives VS Code restarts) */
  constructor(private readonly _dir: string) {}

  /** The remembered list, or undefined when there is none for this key. */
  read(projectRoot: string, key: string): string[] | undefined {
    return this.readEntry(projectRoot, key)?.files;
  }

  /**
   * The remembered list, the framework's file groups (Vitest project names)
   * and, in a mixed project, each file's framework — if any.
   */
  readEntry(projectRoot: string, key: string): RunnableEntry | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this._file(projectRoot), 'utf8')) as { key?: string; files?: unknown; groups?: unknown; frameworks?: unknown };
      if (data.key !== key || !Array.isArray(data.files)) { return undefined; }
      const record = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : undefined;
      return { files: data.files.filter((f): f is string => typeof f === 'string'), groups: record(data.groups), frameworks: record(data.frameworks) };
    } catch {
      return undefined; // none yet, or unreadable — ask Jest
    }
  }

  /** @throws when the file cannot be written (the next Start then asks Jest again) */
  write(projectRoot: string, key: string, files: string[], groups?: Record<string, string>, frameworks?: Record<string, string>): void {
    fs.mkdirSync(this._dir, { recursive: true });
    fs.writeFileSync(this._file(projectRoot), JSON.stringify({ key, files, ...(groups ? { groups } : {}), ...(frameworks ? { frameworks } : {}) }), 'utf8');
  }

  private _file(projectRoot: string): string {
    const id = crypto.createHash('sha256').update(runnableKey(projectRoot)).digest('hex').slice(0, 16);
    return path.join(this._dir, `runnable-files-${id}.json`);
  }
}
