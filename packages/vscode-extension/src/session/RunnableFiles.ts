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

/** Files in the project root that can change which tests Jest runs. */
const CONFIG_FILES = [
  'package.json',
  'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
  'jest.config.ts', 'jest.config.cts', 'jest.config.mts',
  'jest.config.json',
];

/** Comparable spelling of a path (case-insensitive on Windows). */
export function runnableKey(filePath: string): string {
  const p = path.normalize(filePath);
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
  for (const f of testFiles.map(runnableKey).sort()) { h.update(f).update('\0'); }
  return h.digest('hex');
}

export class RunnableFilesCache {
  /** @param _dir folder shared by all sessions (survives VS Code restarts) */
  constructor(private readonly _dir: string) {}

  /** The remembered list, or undefined when there is none for this key. */
  read(projectRoot: string, key: string): string[] | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this._file(projectRoot), 'utf8')) as { key?: string; files?: unknown };
      if (data.key !== key || !Array.isArray(data.files)) { return undefined; }
      return data.files.filter((f): f is string => typeof f === 'string');
    } catch {
      return undefined; // none yet, or unreadable — ask Jest
    }
  }

  /** @throws when the file cannot be written (the next Start then asks Jest again) */
  write(projectRoot: string, key: string, files: string[]): void {
    fs.mkdirSync(this._dir, { recursive: true });
    fs.writeFileSync(this._file(projectRoot), JSON.stringify({ key, files }), 'utf8');
  }

  private _file(projectRoot: string): string {
    const id = crypto.createHash('sha256').update(runnableKey(projectRoot)).digest('hex').slice(0, 16);
    return path.join(this._dir, `runnable-files-${id}.json`);
  }
}
