import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Jest session transform on single-file components (.vue, .svelte, …): the
 * project's own transformer compiles them, the JS it returns is instrumented
 * and every recorded line / coverage location is moved back to the
 * component through the transformer's source map. Code the compiler added
 * (no mapping) is neither counted nor traced. Jest's ESM mode
 * (processAsync, supportsStaticESM) loads the runtime with an import.
 */

const OURS = path.resolve(__dirname, '..', 'src', 'session', 'instrumentation', 'jest', 'sessionTraceTransform.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _vlq: vlq } = require('../src/session/instrumentation/vitest/vitestTraceTransform.js');

const REPO = path.resolve(__dirname, '..', '..', '..');

let dir: string;
let manifests: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-jcomp-')));
  manifests = path.join(dir, 'manifests');
  process.env.LTR_MANIFEST_DIR = manifests;
  // The project's Babel (a Jest project always has it): linked from the repo's store.
  for (const pkg of ['traverse', 'generator', 'types', 'parser']) {
    const real = path.dirname(require.resolve(`@babel/${pkg}/package.json`, { paths: [path.join(REPO, 'node_modules', '.pnpm'), __dirname] }));
    fs.mkdirSync(path.join(dir, 'node_modules', '@babel'), { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'node_modules', '@babel', pkg), 'junction');
  }
});
afterEach(() => {
  delete process.env.LTR_MANIFEST_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for vue-jest: wraps the <script> block in compiler code. Each
 * script line maps to its line in the .vue file; the added lines map nowhere.
 */
const COMPILER = `
const vlq = ${vlq.toString()};
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function compile(src, file) {
  const lines = src.split('\\n');
  const start = lines.findIndex((l) => l.startsWith('<script'));
  const end = lines.findIndex((l) => l.startsWith('</script'));
  const script = lines.slice(start + 1, end);
  const code = ['"use strict";', 'var __added = [1, 2].map(function (x) { return x ? x : 0; });', ...script, 'module.exports = { total: total };'].join('\\n');
  let prev = 0;
  const mappings = ['', '', ...script.map((_, i) => { const orig = start + 1 + i; const seg = vlq(0) + vlq(0) + vlq(orig - prev) + vlq(0); prev = orig; return seg; }), ''].join(';');
  return { code, map: { version: 3, sources: [require('path').basename(file)], mappings } };
}
`;

function project(transformerFile: string, transformerSrc: string, name = 'Cart.vue'): { file: string; options: any } {
  const transformer = path.join(dir, transformerFile);
  fs.writeFileSync(transformer, transformerSrc);
  const file = path.join(dir, 'src', name);
  const ext = path.extname(name).slice(1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '<template>',
    '  <p>{{ total([1, 2]) }}</p>',
    '</template>',
    '<script>',
    'function total(items) {',
    '  let sum = 0;',
    '  for (const i of items) { sum += i > 0 ? i : 0; }',
    '  return sum;',
    '}',
    '</script>',
  ].join('\n'));
  const options = {
    config: { rootDir: dir, cwd: dir, transform: [[`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.+\\.${ext}$`, OURS], [`\\.${ext}$`, transformer]] },
    configString: '{}', cacheFS: new Map(), transformerConfig: {},
  };
  return { file, options };
}

function manifest(): any {
  const files = fs.readdirSync(manifests);
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(manifests, files[0]), 'utf8'));
}

/** Runs instrumented CJS code; returns the step lines. */
function run(code: string): { steps: number[]; exports: any } {
  const steps: number[] = [];
  const g = globalThis as any;
  const before = [g.__strace, g.__cov];
  g.__strace = { step: (line: number) => steps.push(line) };
  try {
    const mod = { exports: {} as any };
    const req = (id: string) => (/sessionTraceRuntime/.test(id) ? {} : require(id));
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
    mod.exports.total([1, 2]);
    if (typeof mod.exports.render === 'function') { mod.exports.render(); }
    return { steps, exports: mod.exports };
  } finally {
    [g.__strace, g.__cov] = before;
  }
}

it('instruments the compiled component with the component\'s own lines; compiler code is not counted', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const { file, options } = project('fake-vue-jest.js', `${COMPILER}\nmodule.exports = { process: (src, file) => compile(src, file) };`);
  const out = T.process(fs.readFileSync(file, 'utf8'), file, options);
  const m = manifest();
  const stmtLines = Object.values(m.statements).map((s: any) => s.start.line).sort((a, b) => a - b);
  expect(stmtLines).toEqual([6, 7, 7, 8]); // let, for, sum +=, return — not the compiler's lines 1–2 / exports
  expect(Object.values(m.functions).map((f: any) => [f.name, f.start.line])).toEqual([['total', 5]]);
  expect(Object.values(m.branches).map((b: any) => [b.type, b.line])).toEqual([['cond-expr', 7]]);
  const { steps } = run(out.code);
  expect([...new Set(steps)].sort()).toEqual([6, 7, 8]);
});

it('a transformer without a source map: the compiled code runs as is (no wrong lines)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const { file, options } = project('fake-nomap.js', `${COMPILER}\nmodule.exports = { process: (src, file) => ({ code: compile(src, file).code }) };`);
  const out = T.process(fs.readFileSync(file, 'utf8'), file, options);
  expect(out.code).not.toMatch(/__strace/);
  expect(fs.existsSync(manifests)).toBe(false);
});

it('Jest ESM mode: an ESM-only transformer\'s processAsync; the runtime is imported, not required', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const { file, options } = project('fake-svelte-jester.mjs', `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
${COMPILER}
export function process() { throw new Error('use processAsync'); }
export async function processAsync(src, file) { return compile(src, file); }`);
  void T;
  // import() of the ESM-only transformer needs a plain Node process (as Jest's own), not Jest's sandbox.
  const script = path.join(dir, 'run.cjs');
  fs.writeFileSync(script, `const T = require(${JSON.stringify(OURS)});
const o = JSON.parse(process.argv[3]); o.cacheFS = new Map(); o.supportsStaticESM = true;
T.processAsync(require('fs').readFileSync(process.argv[2], 'utf8'), process.argv[2], o).then((r) => process.stdout.write(r.code));`);
  const r = spawnSync(process.execPath, [script, file, JSON.stringify({ ...options, cacheFS: undefined })], { encoding: 'utf8', env: { ...process.env } });
  if (r.status !== 0) { throw new Error(r.stderr); }
  const out = { code: r.stdout };
  expect(out.code.split('\n')[0]).toMatch(/^import ".*sessionTraceRuntime\.js";$/);
  expect(out.code).not.toMatch(/require\(".*sessionTraceRuntime/);
  expect(Object.keys(manifest().statements)).toHaveLength(4);
});

it('the cache key differs between CJS and ESM mode (the output does)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const a = T.getCacheKey('x', '/p/a.js', { configString: '{}', supportsStaticESM: false });
  const b = T.getCacheKey('x', '/p/a.js', { configString: '{}', supportsStaticESM: true });
  expect(a).not.toBe(b);
});

it('any format the project compiles (no extension list): e.g. a .coffee file', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const { file, options } = project('fake-coffee.js', `${COMPILER}\nmodule.exports = { process: (src, file) => compile(src, file) };`, 'cart.coffee');
  const out = T.process(fs.readFileSync(file, 'utf8'), file, options);
  expect(Object.keys(manifest().statements)).toHaveLength(4);
  expect([...new Set(run(out.code).steps)].sort()).toEqual([6, 7, 8]);
});

it('Vue: the render function vue-jest leaves unmapped marks the <template> lines as run (trace only)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const T = require(OURS);
  const withRender = COMPILER.replace(
    "'module.exports = { total: total };'",
    "'function render(_ctx) { var x = 1; return x; }', 'module.exports = { total: total, render: render };'",
  );
  const { file, options } = project('fake-vue-jest-render.js', `${withRender}\nmodule.exports = { process: (src, file) => compile(src, file) };`);
  const out = T.process(fs.readFileSync(file, 'utf8'), file, options);
  const m = manifest();
  expect(Object.values(m.statements).map((x: any) => x.start.line).sort((a: number, b: number) => a - b)).toEqual([6, 7, 7, 8]); // coverage unchanged
  expect(Object.values(m.functions).map((f: any) => f.name)).toEqual(['total']);
  const steps = new Set(run(out.code).steps);
  for (const l of [1, 2, 3]) { expect(steps.has(l)).toBe(true); } // <template> … </template>
  expect(steps.has(4)).toBe(false); // <script>
});

describe('TypeScript sources', () => {
  /** A ts-jest-like transformer that type-checks: rejects code with our inserted calls, returns an inline source map. */
  const STRICT = `
const vlq = ${vlq.toString()};
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
module.exports = {
  process(src, file) {
    if (src.includes('__strace') || src.includes('__cov')) { throw new Error('TS2304: Cannot find name __strace'); }
    const code = src.replace(/: number(\\[\\])?/g, '').replace(/export function/g, 'function') + '\\nmodule.exports = { total };';
    const lines = src.split('\\n');
    const mappings = lines.map((_, i) => vlq(0) + vlq(0) + vlq(i === 0 ? 0 : 1) + vlq(0)).join(';');
    const map = { version: 3, sources: [require('path').basename(file)], mappings };
    return { code: code + '\\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,' + Buffer.from(JSON.stringify(map)).toString('base64') };
  },
};`;

  function tsProject(name: string, transformerName: string): { file: string; options: any } {
    const transformer = path.join(dir, transformerName);
    fs.writeFileSync(transformer, STRICT);
    const file = path.join(dir, 'src', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      'export function total(items: number[]): number {',
      '  let sum: number = 0;',
      '  for (const i of items) { sum += i; }',
      '  return sum;',
      '}',
    ].join('\n'));
    const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { file, options: { config: { rootDir: dir, cwd: dir, transform: [[`^${esc}/.+\\.ts$`, OURS], ['\\.ts$', transformer]] }, configString: '{}', cacheFS: new Map(), transformerConfig: {} } };
  }

  it('a transformer that rejects the instrumented code (type-checks, e.g. jest-preset-angular): compiled first, lines from its inline map', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const T = require(OURS);
    const { file, options } = tsProject('price.ts', 'fake-ng-jest.js');
    const out = T.process(fs.readFileSync(file, 'utf8'), file, options);
    expect(out.code).toMatch(/__strace\.step/);
    expect(Object.values(manifest().statements).map((x: any) => x.start.line).sort()).toEqual([2, 3, 3, 4]);
    expect([...new Set(run(out.code).steps)].sort()).toEqual([2, 3, 4]);
  });

  it('TypeScript generics in a .ts file parse (no JSX plugin for TypeScript source)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const T = require(OURS);
    const file = path.join(dir, 'src', 'generic.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const src = 'export const id = <T>(x: T): T => x;\nexport const n = id<number>(1);\n';
    fs.writeFileSync(file, src);
    const babelLike = path.join(dir, 'passthrough.js');
    fs.writeFileSync(babelLike, 'module.exports = { process: (src) => ({ code: src }) };');
    const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = T.process(src, file, { config: { rootDir: dir, cwd: dir, transform: [[`^${esc}/.+\\.ts$`, OURS], ['\\.ts$', babelLike]] }, configString: '{}' });
    expect(out.code).toMatch(/__strace\.step\(2,/);
  });
});
