import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findTestProjects,
  pnpmWorkspacePackages,
  expandWorkspaceGlobs,
  workspaceGlobs,
  hasOwnTestConfig,
  testFrameworkOf,
} from '../src/framework/projectDiscovery';

/** Writes `files` (path → content; objects are JSON) under a new temp folder. */
function tree(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr projects '));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('project discovery', () => {
  const dirs: string[] = [];
  const make = (files: Record<string, string | object>) => { const d = tree(files); dirs.push(d); return d; };
  afterAll(() => { for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); } });
  const rel = (root: string, ps: { root: string }[]) => ps.map((p) => path.relative(root, p.root) || '.');

  it('reads pnpm-workspace.yaml packages in block and flow style', () => {
    expect(pnpmWorkspacePackages("packages:\n  - 'packages/*'\n  - \"apps/*\" # apps\n\n  - '!**/test/**'\ncatalog:\n  a: 1\n"))
      .toEqual(['packages/*', 'apps/*', '!**/test/**']);
    expect(pnpmWorkspacePackages("ignoreWorkspaceRootCheck: true\npackages: [docs, 'tools/*']\n")).toEqual(['docs', 'tools/*']);
    expect(pnpmWorkspacePackages('trustPolicy: no-downgrade\n')).toEqual([]);
  });

  it('reads package.json workspaces (array and yarn object form)', () => {
    expect(workspaceGlobs(make({ 'package.json': { workspaces: ['packages/*'] } }))).toEqual(['packages/*']);
    expect(workspaceGlobs(make({ 'package.json': { workspaces: { packages: ['libs/*'] } } }))).toEqual(['libs/*']);
  });

  it('expands *, name patterns, ** and negations, only folders with a package.json', () => {
    const root = make({
      'packages/a/package.json': {}, 'packages/b/package.json': {}, 'packages/notes/readme.md': '',
      'tools/pkg-x/package.json': {}, 'tools/other/package.json': {},
      'deep/one/two/package.json': {}, 'deep/one/test/package.json': {},
      'packages/a/node_modules/dep/package.json': {},
    });
    expect(rel(root, expandWorkspaceGlobs(root, ['packages/*', 'tools/pkg-*']).map((r) => ({ root: r })))).toEqual(
      ['packages/a', 'packages/b', 'tools/pkg-x'].map((p) => p.split('/').join(path.sep)),
    );
    expect(rel(root, expandWorkspaceGlobs(root, ['deep/**', '!**/test']).map((r) => ({ root: r })))).toEqual(
      [path.join('deep', 'one', 'two')],
    );
  });

  it('a root with its own Jest config (projects) is one project, not one per package', () => {
    const root = make({
      'package.json': { name: 'jest-mono', workspaces: ['packages/*'], devDependencies: { jest: '30' } },
      'jest.config.mjs': 'export default { projects: ["packages/*"] }',
      'packages/a/package.json': { name: 'a', devDependencies: { jest: '30' } },
      'packages/b/package.json': { name: 'b', scripts: { test: 'jest' } },
    });
    expect(hasOwnTestConfig(root)).toBe(true);
    const ps = findTestProjects([root]);
    expect(rel(root, ps)).toEqual(['.']);
    expect(ps[0]).toMatchObject({ name: 'jest-mono', framework: 'jest' });
  });

  it('a root with a Vitest config using test.projects is one project (D12)', () => {
    const root = make({
      'package.json': { name: 'vue-mono', devDependencies: { vitest: '4' } },
      'pnpm-workspace.yaml': "packages:\n  - packages/*\n",
      'vitest.config.ts': 'export default { test: { projects: ["packages/*"] } }',
      'packages/core/package.json': { name: '@x/core', scripts: { test: 'vitest' } },
      'packages/core/vitest.config.ts': '',
    });
    expect(findTestProjects([root]).map((p) => p.name)).toEqual(['vue-mono']);
  });

  it('a monorepo root without a test config gives one project per package with tests', () => {
    const root = make({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { vitest: '3' } },
      'packages/web/package.json': { name: 'web', devDependencies: { vitest: '3' } },
      'packages/api/package.json': { name: 'api', scripts: { test: 'jest --ci' } },
      'packages/docs/package.json': { name: 'docs' },
      'packages/lib/package.json': { name: 'lib' },
      'packages/lib/vitest.config.mjs': 'export default {}',
    });
    const ps = findTestProjects([root]);
    expect(ps.map((p) => [p.name, p.framework])).toEqual([['api', 'jest'], ['lib', 'vitest'], ['web', 'vitest']]);
  });

  it('a monorepo root whose packages have no tests is the one project (as before)', () => {
    const root = make({
      'package.json': { name: 'mono', workspaces: ['packages/*'], devDependencies: { jest: '29' } },
      'packages/a/package.json': { name: 'a' },
    });
    expect(rel(root, findTestProjects([root]))).toEqual(['.']);
  });

  it('a single folder with nothing recognised is still the project (plain Jest fallback)', () => {
    const root = make({ 'readme.md': '' });
    const ps = findTestProjects([root]);
    expect(rel(root, ps)).toEqual(['.']);
    expect(ps[0].framework).toBe('unknown');
  });

  it('several workspace folders: each detected, nested and duplicate roots dropped, names made unique', () => {
    const a = make({ 'package.json': { name: 'app', devDependencies: { jest: '29' } }, 'sub/package.json': { name: 'sub', devDependencies: { jest: '29' } } });
    const b = make({ 'package.json': { name: 'app', devDependencies: { vitest: '3' } } });
    const empty = make({ 'notes.txt': '' });
    const ps = findTestProjects([a, path.join(a, 'sub'), b, empty, b]);
    expect(ps.map((p) => p.root)).toEqual([a, b]);
    expect(new Set(ps.map((p) => p.name)).size).toBe(2);
    expect(ps.every((p) => p.name.startsWith('app ('))).toBe(true);
  });

  it('several folders with nothing recognised give no project', () => {
    expect(findTestProjects([make({ 'a.txt': '' }), make({ 'b.txt': '' })])).toEqual([]);
  });

  it('testFrameworkOf: dependency, config or test script', () => {
    expect(testFrameworkOf(make({ 'package.json': { scripts: { test: 'vitest run' } } }))).toBe('vitest');
    expect(testFrameworkOf(make({ 'package.json': { scripts: { test: 'react-scripts test' } } }))).toBe('cra');
    expect(testFrameworkOf(make({ 'package.json': { scripts: { test: 'tsc' } } }))).toBeUndefined();
  });
});
