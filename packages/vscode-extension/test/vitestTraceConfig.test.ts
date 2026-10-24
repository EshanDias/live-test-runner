import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestTrace } from '../src/session/VitestTrace';

/**
 * Vitest execution trace (phase 9, ADR-9): the wrapper config. Its helper is
 * ESM-loaded by Vitest, so it runs here in a plain Node child process with a
 * stand-in for Vite (loadConfigFromFile / mergeConfig).
 */

const INSTR = path.resolve(__dirname, '..', 'src', 'session', 'instrumentation', 'vitest');
const HELPER = path.join(INSTR, 'vitestTraceConfig.js');
const SETUP = path.join(INSTR, 'vitestTraceSetup.mjs');

const FAKE_VITE = `
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
export async function loadConfigFromFile(env, file) {
  // Vite bundles imports by absolute path; plain Node needs file URLs (Windows).
  const src = readFileSync(file, 'utf8');
  if (src.includes('Live Test Runner: loads')) {
    writeFileSync(file, src.replace(/from "([^"]+)"/g, (_, p) => 'from ' + JSON.stringify(pathToFileURL(p).href)));
  }
  const m = await import(pathToFileURL(file).href + '?' + Math.random());
  const c = typeof m.default === 'function' ? await m.default(env) : m.default;
  return { path: file, config: c };
}
export function mergeConfig(a, b) {
  return { ...a, ...b, plugins: [...(a.plugins || []), ...(b.plugins || [])], test: { ...(a.test || {}), ...(b.test || {}) } };
}
export function searchForWorkspaceRoot(root) { return root; }
`;

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-vtcfg-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: string): string {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

/** Loads `wrapper` like Vitest would and returns a JSON-able summary of the config. */
function load(wrapper: string, env: Record<string, string> = {}): any {
  const script = write('load.mjs', `
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.argv[2]).href);
const c = await m.default({ command: 'serve', mode: 'test' });
const describe = (cfg) => ({
  root: cfg.root, name: cfg.test && cfg.test.name,
  workspace: cfg.test && (Array.isArray(cfg.test.workspace)
    ? cfg.test.workspace.map((p) => typeof p === 'string' ? p : { name: p.test && p.test.name, root: p.root, extends: p.extends, plugins: (p.plugins || []).map((x) => x && x.name) })
    : cfg.test.workspace),
  plugins: (cfg.plugins || []).map((p) => p && p.name),
  projects: cfg.test && cfg.test.projects && cfg.test.projects.map((p) => typeof p === 'string' ? p : { name: p.test && p.test.name, extends: p.extends, plugins: (p.plugins || []).map((x) => x && x.name) }),
});
process.stdout.write(JSON.stringify(describe(c)));
`);
  const marker = path.join(dir, 'marker.json');
  const r = spawnSync(process.execPath, [script, wrapper], { encoding: 'utf8', env: { ...process.env, LTR_VITEST_TRACE_MARKER: marker, ...env } });
  if (r.status !== 0) { throw new Error(r.stderr); }
  return { config: JSON.parse(r.stdout), marker: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : undefined };
}

function wrapper(options: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { wrapperSource } = require(HELPER);
  const file = path.join(dir, 'session', 'ltr.vitest.config.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperSource({
    helper: HELPER, vite: write('vite.mjs', FAKE_VITE), projectRoot: dir, major: 4,
    setupFile: SETUP, parser: require.resolve('@babel/parser'), wrapperDir: path.dirname(file), vitestDir: dir, selfFile: file,
    ...options,
  }));
  return file;
}

it('adds the trace plugin to a config without projects', () => {
  const cfg = write('vitest.config.mjs', 'export default { plugins: [{ name: "own" }], test: { include: ["src/**"] } };');
  const { config, marker } = load(wrapper({ config: cfg }));
  expect(config.plugins).toEqual(['own', 'live-test-runner:trace']);
  expect(marker).toEqual({ ok: true, projects: 0, reason: '' });
});

it('works without any project config', () => {
  const { config, marker } = load(wrapper({ config: null }));
  expect(config.plugins).toEqual(['live-test-runner:trace']);
  expect(marker.ok).toBe(true);
});

describe('Vitest 3 workspaces', () => {
  it('a workspace file next to the config: passed inline, entries wrapped, paths from the file\'s folder', () => {
    write('packages/lib/vitest.config.mjs', 'export default {};');
    const cfg = write('configs/vitest.config.mjs', 'export default { test: { include: ["x"] } };');
    write('configs/vitest.workspace.mjs', `export default [
      { test: { name: 'unit' } },
      { root: './sub', extends: './vitest.config.mjs', test: { name: 'sub' } },
      'packages/*',
    ];`);
    const { config, marker } = load(wrapper({ config: cfg, major: 3 }));
    expect(marker).toEqual({ ok: true, projects: 3, reason: '' });
    expect(config.plugins).toEqual(['live-test-runner:trace']);
    const [unit, sub, lib] = config.workspace;
    expect(unit).toEqual({ name: 'unit', plugins: ['live-test-runner:trace'] });
    expect(sub.root).toBe(path.join(dir, 'configs', 'sub'));
    expect(sub.extends).toBe(path.join(dir, 'configs', 'vitest.config.mjs'));
    expect(path.basename(lib)).toBe('vitest.config.mjs');
    expect(lib.startsWith(path.join(dir, 'session'))).toBe(true);
    // The loader stays in the session folder; nothing is written into the project.
    expect(fs.readdirSync(path.join(dir, 'configs')).sort()).toEqual(['vitest.config.mjs', 'vitest.workspace.mjs']);
  });

  it('a JSON workspace file, without a project config (looked up at the root)', () => {
    write('packages/lib/vitest.config.mjs', 'export default {};');
    write('vitest.projects.json', JSON.stringify(['packages/*']));
    const { config, marker } = load(wrapper({ config: null, major: 3 }));
    expect(marker.ok).toBe(true);
    expect(config.workspace).toHaveLength(1);
  });

  it('`test.workspace` inline; an entry naming the root config is the root project (the wrapper)', () => {
    const cfg = write('vitest.config.mjs', `export default { test: { workspace: [
      { extends: true, test: { name: 'app' } },
      './vitest.config.mjs',
    ] } };`);
    const w = wrapper({ config: cfg, major: 3 });
    const { config, marker } = load(w);
    expect(marker).toEqual({ ok: true, projects: 2, reason: '' });
    expect(config.workspace[0]).toEqual({ name: 'app', extends: true, plugins: ['live-test-runner:trace'] });
    expect(config.workspace[1]).toBe(w);
  });

  it('`test.workspace` naming a file', () => {
    write('ws/list.mjs', 'export default [{ test: { name: "a" } }];');
    const cfg = write('vitest.config.mjs', 'export default { test: { workspace: "./ws/list.mjs" } };');
    const { config } = load(wrapper({ config: cfg, major: 3 }));
    expect(config.workspace).toEqual([{ name: 'a', plugins: ['live-test-runner:trace'] }]);
  });

  it('Vitest 4+ has no workspaces: a workspace file is left alone', () => {
    const cfg = write('vitest.config.mjs', 'export default {};');
    write('vitest.workspace.mjs', 'export default [{ test: { name: "a" } }];');
    const { config, marker } = load(wrapper({ config: cfg, major: 4 }));
    expect(config.workspace).toBeUndefined();
    expect(marker.ok).toBe(true);
  });
});

it('reaches every project: inline ones get the plugin, folders and config files a wrapper of their own', () => {
  write('packages/lib/package.json', JSON.stringify({ name: 'the-lib' }));
  write('packages/lib/vitest.config.mjs', 'export default { test: { include: ["src/**"] } };');
  write('packages/bare/x.txt', '');
  write('tools/vitest.config.mjs', 'export default { root: "inner", test: { name: "tools" } };');
  const cfg = write('vitest.config.mjs', `export default { test: { projects: [
    { test: { name: 'unit' } },
    { extends: true, test: { name: 'inherits' } },
    'packages/*',
    './tools/vitest.config.mjs',
  ] } };`);
  const { config, marker } = load(wrapper({ config: cfg }));
  expect(marker).toEqual({ ok: true, projects: 5, reason: '' });
  const [unit, inherits, ...files] = config.projects;
  expect(unit).toEqual({ name: 'unit', plugins: ['live-test-runner:trace'] });
  // Vitest 4: `extends: true` reloads the root (the wrapper) — the plugin is idempotent, so adding it is safe
  expect(inherits.plugins).toEqual(['live-test-runner:trace']);
  expect(files).toHaveLength(3);
  for (const f of files) { expect(path.basename(f)).toBe('vitest.config.mjs'); expect(f.startsWith(path.join(dir, 'session'))).toBe(true); }

  const loaded = files.map((f: string) => load(f).config);
  const byName = Object.fromEntries(loaded.map((c: any) => [c.name, c]));
  expect(Object.keys(byName).sort()).toEqual(['bare', 'the-lib', 'tools']);
  expect(byName['the-lib'].root).toBe(path.join(dir, 'packages', 'lib'));
  expect(byName.bare.root).toBe(path.join(dir, 'packages', 'bare'));
  expect(byName.tools.root).toBe(path.join(dir, 'tools', 'inner'));
  for (const c of loaded) { expect(c.plugins).toContain('live-test-runner:trace'); }
});

it('Vitest 5: an inline project that extends the declaring config inherits the plugin (keeps the shared server)', () => {
  const cfg = write('vitest.config.mjs', `export default { test: { projects: [
    { test: { name: 'default-extends' } },
    { extends: false, test: { name: 'alone' } },
  ] } };`);
  const { config } = load(wrapper({ config: cfg, major: 5 }));
  expect(config.projects[0].plugins).toEqual([]);
  expect(config.projects[1].plugins).toEqual(['live-test-runner:trace']);
});

it('the e2e switch breaks the wrapper (the fallback path)', () => {
  const cfg = write('vitest.config.mjs', 'export default {};');
  expect(() => load(wrapper({ config: cfg }), { LTR_E2E_BREAK_TRACE_WRAPPER: '1' })).toThrow(/LTR_E2E_BREAK_TRACE_WRAPPER/);
});

describe('VitestTrace', () => {
  const assets = () => ({ helper: HELPER, setup: SETUP, parser: require.resolve('@babel/parser') });
  function install(version: string): void {
    write('package.json', JSON.stringify({ devDependencies: { vitest: version } }));
    write('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', version, bin: { vitest: './vitest.mjs' } }));
    write('node_modules/vitest/vitest.mjs', '');
    write('node_modules/vite/package.json', JSON.stringify({ name: 'vite', exports: { '.': './index.js', './package.json': './package.json' } }));
    write('node_modules/vite/index.js', '');
  }

  it('writes the wrapper for a root, once per session', () => {
    install('4.1.0');
    const vt = new VitestTrace(path.join(dir, 'session'), () => true, assets());
    const a = vt.configFor(dir, undefined);
    expect(a && fs.existsSync(a)).toBe(true);
    expect(fs.readFileSync(a!, 'utf8')).toContain('"major":4');
    expect(fs.readFileSync(a!, 'utf8')).toContain('"componentExtensions":["vue","svelte","astro","marko"]');
    expect(vt.configFor(dir, undefined)).toBe(a);
    expect(vt.offReason(dir)).toBeUndefined();
  });

  it('is off: by the setting, below Vitest 3, or without Vite — not for a workspace file', () => {
    install('4.1.0');
    expect(new VitestTrace(dir, () => false, assets()).configFor(dir, undefined)).toBeUndefined();
    expect(new VitestTrace(dir, () => false, assets()).offReason(dir)).toMatch(/liveTestRunner\.vitestTrace/);

    write('vitest.workspace.ts', 'export default []');
    let vt = new VitestTrace(path.join(dir, 'session'), () => true, assets());
    expect(vt.configFor(dir, undefined)).toBeDefined(); // the wrapper handles it
    expect(vt.offReason(dir)).toBeUndefined();
    fs.unlinkSync(path.join(dir, 'vitest.workspace.ts'));

    install('2.1.0');
    vt = new VitestTrace(dir, () => true, assets());
    expect(vt.configFor(dir, undefined)).toBeUndefined();
    expect(vt.offReason(dir)).toMatch(/older than 3/);

    install('4.1.0');
    fs.rmSync(path.join(dir, 'node_modules', 'vite'), { recursive: true });
    vt = new VitestTrace(dir, () => true, assets());
    expect(vt.configFor(dir, undefined)).toBeUndefined();
    expect(vt.offReason(dir)).toMatch(/Vite/);
    vt.reset();
    expect(vt.offReason(dir)).toBeUndefined();
  });

  it('turnOff keeps the first reason until reset', () => {
    install('4.1.0');
    const vt = new VitestTrace(path.join(dir, 'session'), () => true, assets());
    vt.turnOff(dir, 'first');
    vt.turnOff(dir, 'second');
    expect(vt.offReason(dir)).toBe('first');
    expect(vt.configFor(dir, undefined)).toBeUndefined();
  });
});
