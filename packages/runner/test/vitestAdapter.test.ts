import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestAdapter, vitestCapabilities } from '../src/framework/adapters/VitestAdapter';
import { NodeRuntime } from '../src/resolution/BinaryResolver';
import { setLogSink } from '../src/utils/logger';

interface Fixture { pkg?: Record<string, unknown>; files?: Record<string, string> }

/** A fake Vitest install inside node_modules. */
const vitestInstall = (version: string, node?: string, bin: unknown = { vitest: './vitest.mjs' }) => ({
  'node_modules/vitest/package.json': JSON.stringify({ name: 'vitest', version, bin, ...(node ? { engines: { node } } : {}) }),
  'node_modules/vitest/vitest.mjs': "import './dist/cli.js'\n",
});

const pathNode: NodeRuntime = { binary: process.execPath, env: {} };
const editorNode: NodeRuntime = { binary: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, isEditorFallback: true };

describe('VitestAdapter (runner)', () => {
  const dirs: string[] = [];
  const logs: string[] = [];
  const project = (f: Fixture): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr vitest ')));
    dirs.push(dir);
    if (f.pkg) { fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(f.pkg)); }
    for (const [rel, text] of Object.entries(f.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };
  beforeAll(() => setLogSink((level, _scope, message) => logs.push(`${level} ${message}`)));
  beforeEach(() => { logs.length = 0; });
  afterAll(() => {
    setLogSink(undefined);
    for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
  });

  describe('detect', () => {
    const detect = (f: Fixture) => new VitestAdapter().detect(project(f));

    it('claims a project with a vitest dependency', () => {
      expect(detect({ pkg: { devDependencies: { vitest: '5' } } })).toBe(true);
      expect(detect({ pkg: { dependencies: { vitest: 'catalog:test' } } })).toBe(true);
    });

    it('claims a project with only a Vitest config or workspace file (hoisted install)', () => {
      expect(detect({ pkg: {}, files: { 'vitest.config.mts': '' } })).toBe(true);
      expect(detect({ pkg: {}, files: { 'vitest.workspace.json': '[]' } })).toBe(true);
    });

    it('does not claim a plain Vite app (vite.config without vitest)', () => {
      expect(detect({ pkg: { devDependencies: { vite: '7' } }, files: { 'vite.config.ts': '' } })).toBe(false);
    });

    it('leaves projects marked as Jest to Jest (BUG-37, jest-dom shape)', () => {
      expect(detect({ pkg: { devDependencies: { vitest: '3', jest: '30' } } })).toBe(false);
      expect(detect({ pkg: { devDependencies: { vitest: '3', 'kcd-scripts': '16' } }, files: { 'jest.config.js': '', 'vitest.js': '' } })).toBe(false);
      expect(detect({ pkg: { devDependencies: { vitest: '3' }, jest: {} } })).toBe(false);
    });

    it('does not claim Jest-only projects or folders without package.json', () => {
      expect(detect({ pkg: { devDependencies: { jest: '30' } } })).toBe(false);
      expect(detect({ files: { 'vitest.config.ts': '' } })).toBe(false);
    });
  });

  describe('install, version and capabilities', () => {
    it('resolves vitest.mjs from package.json#bin', () => {
      const root = project({ pkg: { devDependencies: { vitest: '5' } }, files: vitestInstall('5.0.5') });
      const adapter = new VitestAdapter(() => pathNode);
      expect(adapter.findInstall(root)).toMatchObject({ version: '5.0.5', major: 5 });
      expect(adapter.resolveBinary(root)).toBe(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'));
    });

    it('accepts a string bin and finds an install hoisted to a parent folder', () => {
      const root = project({ pkg: {}, files: vitestInstall('4.1.11', undefined, './vitest.mjs') });
      const pkgDir = path.join(root, 'packages', 'a');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4' } }));
      expect(new VitestAdapter(() => pathNode).resolveBinary(pkgDir)).toBe(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'));
    });

    it('explains a missing install instead of falling back to npx', () => {
      const root = project({ pkg: { devDependencies: { vitest: '5' } } });
      expect(() => new VitestAdapter(() => pathNode).resolveBinary(root)).toThrow(/Vitest is not installed/);
    });

    it('gates capabilities on the installed major', () => {
      expect(vitestCapabilities(5)).toEqual({ results: true, nameFilter: true, coverage: true, listTests: true, related: true, liveStream: true });
      expect(vitestCapabilities(3).listTests).toBe(true);
      expect(vitestCapabilities(2)).toMatchObject({ results: true, nameFilter: true, coverage: true, listTests: false, related: false, liveStream: false });
      expect(vitestCapabilities(undefined).listTests).toBe(true);

      const old = project({ pkg: { devDependencies: { vitest: '2' } }, files: vitestInstall('2.1.9') });
      expect(new VitestAdapter().capabilities(old).related).toBe(false);
      expect(new VitestAdapter().capabilities(project({ pkg: { devDependencies: { vitest: '5' } } })).related).toBe(true);
    });

    it('runs an old Vitest best-effort, warning once', () => {
      const root = project({ pkg: { devDependencies: { vitest: '2' } }, files: vitestInstall('2.1.9') });
      const adapter = new VitestAdapter(() => pathNode);
      adapter.resolveBinary(root);
      adapter.resolveBinary(root);
      expect(logs.filter((l) => l.startsWith('warn') && l.includes('older than the supported 3.x'))).toHaveLength(1);
    });
  });

  describe('Node runtime check', () => {
    // The test process's own Node stands in for both runtimes; the range is
    // chosen so it fails or passes for it.
    const tooNew = `>=${Number(process.versions.node.split('.')[0]) + 1}.0.0`;

    it("fails with an explanation when only the editor's Node exists and it is too old", () => {
      const root = project({ pkg: { devDependencies: { vitest: '5' } }, files: vitestInstall('5.0.5', tooNew) });
      expect(() => new VitestAdapter(() => editorNode).resolveBinary(root)).toThrow(/needs Node .* no "node" was found on PATH/s);
    });

    it("only warns when the user's own Node is outside the range", () => {
      const root = project({ pkg: { devDependencies: { vitest: '5' } }, files: vitestInstall('5.0.5', tooNew) });
      const adapter = new VitestAdapter(() => pathNode);
      expect(adapter.resolveBinary(root)).toContain('vitest.mjs');
      expect(logs.some((l) => l.startsWith('warn') && l.includes('the run may fail'))).toBe(true);
    });

    it('passes when the runtime satisfies the range, or the range is unreadable', () => {
      const ok = project({ pkg: { devDependencies: { vitest: '5' } }, files: vitestInstall('5.0.5', `>=${process.versions.node}`) });
      expect(() => new VitestAdapter(() => editorNode).resolveBinary(ok)).not.toThrow();
      const odd = project({ pkg: { devDependencies: { vitest: '5' } }, files: vitestInstall('5.0.5', '1.0.0 - 2.0.0') });
      expect(() => new VitestAdapter(() => editorNode).resolveBinary(odd)).not.toThrow();
    });
  });

  describe('resolveConfig', () => {
    it('prefers vitest.config.* over vite.config.*', async () => {
      const root = project({ pkg: {}, files: { 'vite.config.ts': '', 'vitest.config.mts': '' } });
      expect(await new VitestAdapter().resolveConfig(root)).toBe(path.join(root, 'vitest.config.mts'));
    });

    it('falls back to vite.config.*, then to letting Vitest decide', async () => {
      const vite = project({ pkg: {}, files: { 'vite.config.js': '' } });
      expect(await new VitestAdapter().resolveConfig(vite)).toBe(path.join(vite, 'vite.config.js'));
      expect(await new VitestAdapter().resolveConfig(project({ pkg: {} }))).toBeUndefined();
    });
  });

  it('parses its json result with the Vitest parser', () => {
    const r = new VitestAdapter().parseResult(false, JSON.stringify({
      testResults: [{
        name: '/p/a.test.ts', status: 'failed',
        assertionResults: [
          { ancestorTitles: ['a'], title: 'ok', fullName: 'a ok', status: 'passed', failureMessages: [] },
          { ancestorTitles: ['a'], title: 'bad', fullName: 'a bad', status: 'failed', failureMessages: ['boom'] },
        ],
      }],
    }), '');
    expect(r.fileResults[0].testCases.map((t) => t.status)).toEqual(['passed', 'failed']);
  });

  it('works on the real Vitest repos when present (read-only)', () => {
    const reposDir = process.env.LTR_E2E_VITEST_REPOS_DIR ?? '/Users/eshandias/Projects/test/vitest-projects';
    for (const repo of ['unplugin', 'slidev', 'vueuse']) {
      const root = path.join(reposDir, repo);
      if (!fs.existsSync(path.join(root, 'node_modules'))) { continue; }
      const adapter = new VitestAdapter(() => pathNode);
      expect(adapter.detect(root)).toBe(true);
      expect(adapter.findInstall(root)?.major).toBeGreaterThanOrEqual(4);
      expect(fs.existsSync(adapter.resolveBinary(root))).toBe(true);
    }
  });
});
