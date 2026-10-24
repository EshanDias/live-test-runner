import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { esmEntry, viteEntryFor, vitestDirFor } from '../src/framework/vitestTrace';
import { VitestRunner, _setVitestConfigReader } from '../src/VitestRunner';
import { _resetProjectRoots } from '../src/resolution/RunnerPaths';

/** Vitest execution trace (phase 9): finding the project's Vite, and the wrapper config in the command. */

let root: string;

function pkg(dir: string, json: object, files: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
}

beforeEach(() => {
  _resetProjectRoots();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vtrace-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4.1.0' } }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('esmEntry', () => {
  it('reads every shape of exports["."]', () => {
    expect(esmEntry('./dist/node/index.js')).toBe('./dist/node/index.js');
    expect(esmEntry({ import: './a.mjs', require: './a.cjs' })).toBe('./a.mjs');
    expect(esmEntry({ import: { types: './a.d.ts', default: './a.mjs' } })).toBe('./a.mjs');
    expect(esmEntry({ default: './d.js' })).toBe('./d.js');
    expect(esmEntry(undefined)).toBeUndefined();
  });
});

describe('viteEntryFor', () => {
  it('finds Vite through the project\'s Vitest (nested install)', () => {
    const vitest = path.join(root, 'node_modules', 'vitest');
    pkg(vitest, { name: 'vitest', version: '4.1.0' });
    pkg(path.join(vitest, 'node_modules', 'vite'), { name: 'vite', exports: { '.': { import: './dist/node/index.js' }, './package.json': './package.json' } }, { 'dist/node/index.js': '' });
    expect(vitestDirFor(root)).toBe(vitest);
    expect(viteEntryFor(root)).toBe(path.join(vitest, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  });

  it('finds a hoisted Vite with a string export', () => {
    pkg(path.join(root, 'node_modules', 'vitest'), { name: 'vitest', version: '4.1.0' });
    pkg(path.join(root, 'node_modules', 'vite'), { name: 'vite', exports: { '.': './dist/node/index.js', './package.json': './package.json' } }, { 'dist/node/index.js': '' });
    expect(viteEntryFor(root)).toBe(path.join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js'));
  });

  it('is undefined without Vitest, without Vite, or when the entry file is missing', () => {
    expect(viteEntryFor(root)).toBeUndefined();
    pkg(path.join(root, 'node_modules', 'vitest'), { name: 'vitest', version: '4.1.0' });
    expect(viteEntryFor(root)).toBeUndefined();
    pkg(path.join(root, 'node_modules', 'vite'), { name: 'vite', exports: { '.': './dist/node/index.js', './package.json': './package.json' } });
    expect(viteEntryFor(root)).toBeUndefined();
  });
});

describe('VitestRunner.liveCommand with a wrapper config', () => {
  beforeAll(() => _setVitestConfigReader(async () => ({ projects: [{ name: '', browser: false }], coverageProvider: 'v8' })));
  afterAll(() => _setVitestConfigReader());

  function install(): void {
    const dir = path.join(root, 'node_modules', 'vitest');
    pkg(dir, { name: 'vitest', version: '4.1.0', bin: { vitest: './vitest.mjs' } }, { 'vitest.mjs': '' });
    fs.writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {}');
  }

  it('passes the wrapper with --config instead of the project config', async () => {
    install();
    const runner = new VitestRunner();
    runner.setProjectRoot(root);
    expect(await runner.projectConfigPath()).toBe(path.join(root, 'vitest.config.ts'));
    const wrapper = path.join(root, 'w', 'ltr.vitest.config.mjs');
    const r = await runner.liveCommand([path.join(root, 'a.test.ts')], { config: wrapper });
    const i = r.command.args.indexOf('--config');
    expect(r.command.args[i + 1].replace(/\\/g, '/')).toBe(wrapper.replace(/\\/g, '/'));
    expect(r.command.args.filter((a) => a === '--config')).toHaveLength(1);
  });

  it('keeps the project config without one', async () => {
    install();
    const runner = new VitestRunner();
    runner.setProjectRoot(root);
    const r = await runner.liveCommand([path.join(root, 'a.test.ts')]);
    const i = r.command.args.indexOf('--config');
    expect(r.command.args[i + 1].replace(/\\/g, '/')).toBe(path.join(root, 'vitest.config.ts').replace(/\\/g, '/'));
  });
});
