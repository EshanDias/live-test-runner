import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFrameworkAllowedAt } from '@live-test-runner/runner';
import { FrameworkRouter } from '../src/framework/FrameworkRouter';
import { FrameworkServices } from '../src/framework/FrameworkServices';

/** Phase 8: which framework runs each test file of a project. */

function tree(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr router '));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** A bundle whose adapter lists `files()` (throws when it returns undefined). */
function fakeBundle(name: 'Jest' | 'Vitest', files: () => string[] | undefined, groups?: () => Record<string, string>): FrameworkServices {
  return {
    framework: name.toLowerCase(),
    displayName: name,
    terms: { name, listCommand: `${name.toLowerCase()} list` },
    settingsFingerprint: () => `${name}-settings`,
    adapter: {
      isTestFile: (f: string) => /\.(test|spec)\.[jt]s$/.test(f),
      listTestFiles: async () => {
        const list = files();
        if (!list) { throw new Error(`${name} could not list`); }
        return { files: list, groups: groups?.() };
      },
    },
  } as unknown as FrameworkServices;
}

describe('FrameworkRouter', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); } });
  const make = (files: Record<string, string | object>) => { const d = tree(files); dirs.push(d); return d; };

  /** A Jest root with its own Vitest config; both default globs match every *.test.ts. */
  const mixedRoot = () => make({
    'package.json': { devDependencies: { jest: '29', vitest: '3' } },
    'jest.config.js': 'module.exports = {}',
    'vitest.config.ts': 'export default {}',
    'src/plain.test.ts': `it('x', () => expect(1).toBe(1))`,
    'src/vi.test.ts': `import { it, vi } from 'vitest'\nit('x', () => vi.fn())`,
    'src/jestish.test.ts': `jest.mock('./x')\nit('x', () => {})`,
    'src/only-jest.spec.js': `it('x', () => {})`,
    'src/only-vitest.test.ts': `it('x', () => {})`,
  });

  function router(root: string, lists: { jest?: string[]; vitest?: string[] }, setting?: unknown) {
    const r = new FrameworkRouter(
      {
        jest: () => fakeBundle('Jest', () => lists.jest),
        vitest: () => fakeBundle('Vitest', () => lists.vitest, () => Object.fromEntries((lists.vitest ?? []).map((f) => [f, 'unit']))),
      },
      root,
      () => root,
      () => setting,
    );
    r.prepare();
    return r;
  }

  it('a pure Jest project: one bundle, no Vitest listing', async () => {
    const root = make({ 'package.json': { devDependencies: { jest: '29' } }, 'a.test.js': '' });
    let vitestAsked = false;
    const r = new FrameworkRouter(
      { jest: () => fakeBundle('Jest', () => [path.join(root, 'a.test.js')]), vitest: () => { vitestAsked = true; return fakeBundle('Vitest', () => []); } },
      root, () => root, () => undefined,
    );
    r.prepare();
    expect(r.isMixed()).toBe(false);
    const listing = await r.listTestFiles(root, [path.join(root, 'a.test.js')], () => {});
    expect(listing).toEqual({ files: [path.join(root, 'a.test.js')], groups: undefined });
    expect(vitestAsked).toBe(false);
    expect(r.servicesFor(path.join(root, 'a.test.js')).displayName).toBe('Jest');
    expect(r.all()).toHaveLength(1);
  });

  it('a mixed project places each file once: ownership, hints, then the main framework', async () => {
    const root = mixedRoot();
    const f = (n: string) => path.join(root, 'src', n);
    const r = router(root, {
      jest: [f('plain.test.ts'), f('vi.test.ts'), f('jestish.test.ts'), f('only-jest.spec.js')],
      vitest: [f('plain.test.ts'), f('vi.test.ts'), f('jestish.test.ts'), f('only-vitest.test.ts')],
    });
    expect(r.isMixed()).toBe(true);
    expect(isFrameworkAllowedAt(root, 'vitest')).toBe(true);

    const listing = await r.listTestFiles(root, [f('plain.test.ts')], () => {});
    expect(listing.files.sort()).toEqual([f('jestish.test.ts'), f('only-jest.spec.js'), f('only-vitest.test.ts'), f('plain.test.ts'), f('vi.test.ts')].sort());
    expect(listing.frameworks).toEqual({
      [f('plain.test.ts')]: 'jest:primary',
      [f('vi.test.ts')]: 'vitest:hint',
      [f('jestish.test.ts')]: 'jest:hint',
      [f('only-jest.spec.js')]: 'jest:ownership',
      [f('only-vitest.test.ts')]: 'vitest:ownership',
    });
    // Explorer groups by framework (with Vitest's project name).
    expect(listing.groups?.[f('vi.test.ts')]).toBe('Vitest · unit');
    expect(listing.groups?.[f('plain.test.ts')]).toBe('Jest');

    const fw = (n: string) => r.servicesFor(f(n)).displayName;
    expect([fw('plain.test.ts'), fw('vi.test.ts'), fw('jestish.test.ts'), fw('only-vitest.test.ts')]).toEqual(['Jest', 'Vitest', 'Jest', 'Vitest']);
    // Source files and the root: the main framework.
    expect(r.servicesFor(path.join(root, 'src', 'math.ts')).displayName).toBe('Jest');
    expect(r.servicesFor(root).displayName).toBe('Jest');
    expect(r.all()).toHaveLength(2);
  });

  it('a saved file that now imports vitest moves to Vitest; ownership never moves', async () => {
    const root = mixedRoot();
    const f = (n: string) => path.join(root, 'src', n);
    const r = router(root, { jest: [f('plain.test.ts'), f('only-jest.spec.js')], vitest: [f('plain.test.ts')] });
    await r.listTestFiles(root, [], () => {});
    expect(r.servicesFor(f('plain.test.ts')).displayName).toBe('Jest');
    fs.writeFileSync(f('plain.test.ts'), `import { it } from 'vitest'\nit('x', () => {})`);
    r.fileChanged(f('plain.test.ts'));
    expect(r.servicesFor(f('plain.test.ts')).displayName).toBe('Vitest');
    fs.writeFileSync(f('only-jest.spec.js'), `import { it } from 'vitest'`);
    r.fileChanged(f('only-jest.spec.js'));
    expect(r.servicesFor(f('only-jest.spec.js')).displayName).toBe('Jest');
  });

  it('the setting wins and can make a Jest project mixed', async () => {
    const root = make({
      'package.json': { devDependencies: { jest: '29', vitest: '3' } },
      'legacy/a.test.js': '',
      'next/b.test.ts': '',
    });
    const a = path.join(root, 'legacy/a.test.js');
    const b = path.join(root, 'next/b.test.ts');
    const r = router(root, { jest: [a, b], vitest: [a, b] }, { 'next/**': 'vitest' });
    expect(r.isMixed()).toBe(false); // no Vitest config of its own
    const listing = await r.listTestFiles(root, [a, b], () => {});
    expect(r.isMixed()).toBe(true);
    expect(listing.frameworks).toEqual({ [a]: 'jest:primary', [b]: 'vitest:setting' });
    expect(r.servicesFor(b).displayName).toBe('Vitest');
    expect(r.fingerprint()).toContain('frameworks={"next/**":"vitest"}');
  });

  it('a setting that matches no file of this project keeps it single-framework', async () => {
    const root = make({ 'package.json': { devDependencies: { jest: '29' } }, 'a.test.js': '' });
    const a = path.join(root, 'a.test.js');
    const r = router(root, { jest: [a] }, { 'other-package/**': 'vitest' });
    await r.listTestFiles(root, [a], () => {});
    expect(r.isMixed()).toBe(false);
    expect(isFrameworkAllowedAt(root, 'vitest')).toBe(false);
  });

  it('restore() puts back a remembered placement and re-reads hints', async () => {
    const root = mixedRoot();
    const f = (n: string) => path.join(root, 'src', n);
    const r = router(root, {});
    r.restore({
      files: [f('plain.test.ts'), f('vi.test.ts'), f('only-vitest.test.ts')],
      frameworks: { [f('plain.test.ts')]: 'jest:primary', [f('vi.test.ts')]: 'jest:primary', [f('only-vitest.test.ts')]: 'vitest:ownership' },
    });
    expect(r.isMixed()).toBe(true);
    expect(r.servicesFor(f('plain.test.ts')).displayName).toBe('Jest');
    expect(r.servicesFor(f('vi.test.ts')).displayName).toBe('Vitest'); // its import is read again
    expect(r.servicesFor(f('only-vitest.test.ts')).displayName).toBe('Vitest');
    r.restore({ files: [] });
    expect(r.isMixed()).toBe(false);
  });

  it('one framework failing to list: the other\'s list still places files', async () => {
    const root = mixedRoot();
    const f = (n: string) => path.join(root, 'src', n);
    const r = router(root, { jest: undefined, vitest: [f('vi.test.ts'), f('only-vitest.test.ts')] });
    const listing = await r.listTestFiles(root, [f('plain.test.ts'), f('vi.test.ts'), f('only-vitest.test.ts')], () => {});
    // Jest (unknown list) may run any file Vitest does not list; Vitest's own files stay Vitest's.
    expect(listing.frameworks).toMatchObject({ [f('plain.test.ts')]: 'jest:ownership', [f('vi.test.ts')]: 'vitest:hint', [f('only-vitest.test.ts')]: 'vitest:ownership' });
  });
});
