import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeStableConfig } from '../src/session/JestBatchRunner';

// Jest names its transform cache after the config file's path: one path per
// config text keeps the cache (and the file map) shared by every batch and session.
describe('writeStableConfig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-stable-cfg-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the same text always gets the same file, written once', () => {
    const a = writeStableConfig(dir, 'module.exports = { a: 1 };');
    expect(fs.readFileSync(a, 'utf8')).toBe('module.exports = { a: 1 };');
    const mtime = fs.statSync(a).mtimeMs;
    const b = writeStableConfig(dir, 'module.exports = { a: 1 };');
    expect(b).toBe(a);
    expect(fs.statSync(b).mtimeMs).toBe(mtime);
  });

  it('a changed text gets a new file (never a stale config or cache)', () => {
    const a = writeStableConfig(dir, 'module.exports = { a: 1 };');
    const c = writeStableConfig(dir, 'module.exports = { a: 2 };');
    expect(c).not.toBe(a);
    expect(fs.readFileSync(c, 'utf8')).toBe('module.exports = { a: 2 };');
  });

  it('leaves no temporary files behind', () => {
    writeStableConfig(dir, 'x');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the folder when it is missing', () => {
    const sub = path.join(dir, 'new', 'cache');
    expect(fs.existsSync(writeStableConfig(sub, 'y'))).toBe(true);
  });
});
