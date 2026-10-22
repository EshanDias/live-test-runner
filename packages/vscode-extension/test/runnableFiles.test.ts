import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunnableFilesCache, runnableCacheKey } from '../src/session/RunnableFiles';

describe('runnable-files cache (jest --listTests answers kept between sessions)', () => {
  let root: string;
  let cacheDir: string;
  const tests = () => [path.join(root, 'a.test.js'), path.join(root, 'b.test.js')];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-runnable-'));
    cacheDir = path.join(root, '.cache');
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"jest"}}');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('returns the remembered list while nothing changed', () => {
    const cache = new RunnableFilesCache(cacheDir);
    const key = runnableCacheKey(root, tests(), 'jest|');
    cache.write(root, key, [tests()[0]]);
    expect(cache.read(root, runnableCacheKey(root, [...tests()].reverse(), 'jest|'))).toEqual([tests()[0]]);
  });

  it('keeps the framework\'s file groups (Vitest project names, D12) with the list', () => {
    const cache = new RunnableFilesCache(cacheDir);
    const key = runnableCacheKey(root, tests(), 'vitest|');
    cache.write(root, key, tests(), { [tests()[0]]: 'unit', [tests()[1]]: 'integration' });
    expect(cache.readEntry(root, key)).toEqual({ files: tests(), groups: { [tests()[0]]: 'unit', [tests()[1]]: 'integration' } });
    cache.write(root, key, tests());
    expect(cache.readEntry(root, key)).toEqual({ files: tests(), groups: undefined });
  });

  it('asks again when a test file is added or removed', () => {
    const key = runnableCacheKey(root, tests(), 'jest|');
    expect(runnableCacheKey(root, [...tests(), path.join(root, 'c.test.js')], 'jest|')).not.toBe(key);
    expect(runnableCacheKey(root, [tests()[0]], 'jest|')).not.toBe(key);
  });

  it('asks again when the Jest config or the run settings change', () => {
    const key = runnableCacheKey(root, tests(), 'jest|');
    fs.writeFileSync(path.join(root, 'jest.config.js'), 'module.exports = { testPathIgnorePatterns: ["b"] };');
    const withConfig = runnableCacheKey(root, tests(), 'jest|');
    expect(withConfig).not.toBe(key);
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"jest --testPathIgnorePatterns e2e"}}');
    expect(runnableCacheKey(root, tests(), 'jest|')).not.toBe(withConfig);
    expect(runnableCacheKey(root, tests(), 'npm|')).not.toBe(runnableCacheKey(root, tests(), 'jest|'));
  });

  it('has nothing for a key it was not written with', () => {
    const cache = new RunnableFilesCache(cacheDir);
    expect(cache.read(root, 'k')).toBeUndefined();
    cache.write(root, 'k', tests());
    expect(cache.read(root, 'other')).toBeUndefined();
  });
});
