import * as path from 'path';

/** Vitest execution trace (phase 9): the transform that inserts `__strace.step(line, file)` calls, and its source map. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../src/session/instrumentation/vitest/vitestTraceTransform.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parser = require('@babel/parser');

const FILE = '/abs/src/math.ts';

/** Every call made by instrumented code: [line, file]. */
function run(code: string, exportsName: string, ...args: unknown[]): { value: unknown; steps: number[] } {
  const steps: number[] = [];
  const g = globalThis as unknown as { __strace?: unknown };
  const before = g.__strace;
  g.__strace = { step: (line: number) => steps.push(line) };
  try {
    const body = code.replace(/^export /gm, '');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`${body}\nreturn ${exportsName};`)();
    return { value: fn(...args), steps };
  } finally {
    g.__strace = before;
  }
}

/** Decodes a v3 source map's mappings into [genLine, genCol, srcLine?, srcCol?] (0-based). */
function decode(mappings: string): number[][] {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out: number[][] = [];
  let srcLine = 0, srcCol = 0, src = 0;
  mappings.split(';').forEach((line, gl) => {
    let genCol = 0;
    for (const seg of line.split(',').filter(Boolean)) {
      const vals: number[] = [];
      let v = 0, shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        v += (d & 31) << shift;
        if (d & 32) { shift += 5; } else { vals.push(v & 1 ? -(v >> 1) : v >> 1); v = 0; shift = 0; }
      }
      genCol += vals[0];
      if (vals.length >= 4) { src += vals[1]; srcLine += vals[2]; srcCol += vals[3]; out.push([gl, genCol, srcLine, srcCol]); } else { out.push([gl, genCol]); }
    }
  });
  return out;
}

describe('instrument', () => {
  const src = [
    'export function total(items) {',   // 1
    '  let sum = 0;',                    // 2
    '  for (const i of items) sum += i;',// 3
    '  if (sum > 10) return 10;',        // 4
    '  return sum;',                     // 5
    '}',                                 // 6
  ].join('\n');

  it('records the lines a call runs, and keeps the behaviour', () => {
    const out = T.instrument(src, FILE, parser);
    expect(out.statements).toBeGreaterThan(0);
    const r = run(out.code, 'total', [1, 2]);
    expect(r.value).toBe(3);
    expect([...new Set(r.steps)]).toEqual([2, 3, 4, 5]);
    const big = run(out.code, 'total', [9, 9]);
    expect(big.value).toBe(10);
  });

  it('keeps every line where it was (no inserted newline)', () => {
    const out = T.instrument(src, FILE, parser);
    expect(out.code.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('is pure insertion: withoutTrace() gives the original text back', () => {
    const tricky = [
      "'use strict';",
      'import { x } from "./x";',
      'export const f = (q) => ({ q });',
      'export const g = () => () => 1;',
      'export function h(a) {',
      '  if (a) return 1; else if (!a) a++;',
      '  while (a) a--;',
      '  switch (a) { case 1: x(); break; default: }',
      '  return a;',
      '}',
    ].join('\n');
    const out = T.instrument(tricky, FILE, parser);
    expect(out.code).not.toBe(tricky);
    expect(T.withoutTrace(out.code)).toBe(tricky);
    // and a function's own source, as toString() returns it
    const fnSrc = out.code.slice(out.code.indexOf('function h'));
    expect(T.withoutTrace(fnSrc)).toBe(tricky.slice(tricky.indexOf('function h')));
  });

  it('wraps expression-bodied arrows and single-statement bodies', () => {
    const code = 'export const tax = (n) => n * 2;\nexport function w(n) { while (n > 0) n--; return n; }';
    const out = T.instrument(code, FILE, parser);
    expect(run(out.code, 'tax', 3)).toEqual({ value: 6, steps: [1] });
    expect(run(out.code, 'w', 2).value).toBe(0);
  });

  it('leaves declarations, types and vi.mock calls alone', () => {
    const code = [
      'import { vi } from "vitest";',
      'vi.mock("./dep");',
      'type T = { a: number };',
      'interface I { a: T }',
      'declare const z: number;',
      'export const k = 1;',
    ].join('\n');
    expect(T.instrument(code, '/abs/x.ts', parser)).toBeNull();
  });

  it('records the original line through the incoming source map (TypeScript compiled before us)', () => {
    // "compiled" code where line 1 maps to source line 3 and line 2 to source line 5
    const compiled = 'let a = 1;\nlet b = 2;';
    const map = { version: 3, sources: [FILE], names: [], mappings: 'AAEA;AAEA' };
    const out = T.instrument(compiled, FILE, parser, map);
    expect(out.code).toContain('step(3,');
    expect(out.code).toContain('step(5,');
  });

  it('drops a statement the incoming map cannot place', () => {
    const compiled = 'let a = 1;\nlet b = 2;';
    const map = { version: 3, sources: [FILE], names: [], mappings: 'AAAA;' };
    const out = T.instrument(compiled, FILE, parser, map);
    expect((out.code.match(/__strace/g) || [])).toHaveLength(1);
  });

  it('maps every original token to its new column, and the step calls to nothing', () => {
    const code = 'let a = 1;\nif (a) a++;';
    const out = T.instrument(code, FILE, parser);
    const segs = decode(out.map.mappings);
    const genLines = out.code.split('\n');
    const at = (gl: number, gc: number) => segs.filter((s) => s[0] === gl && s[1] <= gc).pop();
    // `let` on line 1 → original 0:0
    const letCol = genLines[0].indexOf('let');
    expect(at(0, letCol)).toEqual([0, letCol, 0, 0]);
    // the inserted step call on line 1 is unmapped
    expect(at(0, 0)).toEqual([0, 0]);
    // `a++` on line 2 → original column 7
    const incCol = genLines[1].lastIndexOf('a++');
    expect(at(1, incCol)!.slice(2)).toEqual([1, 7]);
    // the wrapper's `{` maps to the statement it wraps
    const braceCol = genLines[1].indexOf('{');
    expect(at(1, braceCol)!.slice(2)).toEqual([1, 7]);
  });

  it('puts the step before a coverage ignore hint, so the hint still applies to its statement', () => {
    const code = 'let a = 1;\n/* istanbul ignore next */\nfoo();';
    const out = T.instrument(code, FILE, parser);
    expect(out.code).toMatch(/step\(3,[^)]*\);\/\* istanbul ignore next \*\/\nfoo\(\)/);
  });

  it('throws on code it cannot parse', () => {
    expect(() => T.instrument('let = ;', FILE, parser)).toThrow();
  });
});

describe('the plugin', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ltrTracePlugin } = require('../src/session/instrumentation/vitest/vitestTracePlugin.js');
  const root = path.resolve('/proj');
  const setupFile = path.resolve('/ext/instrumentation/vitest/vitestTraceSetup.mjs');
  const make = () => ltrTracePlugin({ setupFile, parser: require.resolve('@babel/parser'), projectRoot: root });

  async function configured(plugin: any, config: any) {
    await plugin.config.handler(config);
    plugin.configResolved({ root, plugins: [plugin], test: config.test });
    return config;
  }

  it('puts the setup file first, once, and allows serving it', async () => {
    const p = make();
    const c = await configured(p, { test: { setupFiles: ['./own.ts', setupFile] }, server: { fs: { allow: ['/proj'] } } });
    expect(c.test.setupFiles).toEqual([setupFile, './own.ts']);
    expect(c.server.fs.allow).toContain(path.dirname(path.dirname(setupFile)));
  });

  it('leaves browser-mode projects alone', async () => {
    const p = make();
    const c = await configured(p, { test: { browser: { enabled: true } } });
    expect(c.test.setupFiles).toBeUndefined();
    expect(p.transform('let a = 1;', path.join(root, 'src/a.js'))).toBeNull();
  });

  it('instruments the project\'s source files only', async () => {
    const p = make();
    await configured(p, { test: {} });
    const t = (id: string) => p.transform('let a = 1;', id);
    expect(t(path.join(root, 'src/a.ts'))).not.toBeNull();
    expect(t(path.join(root, 'src/a.test.ts'))).toBeNull();
    expect(t(path.join(root, 'src/__tests__/a.ts'))).toBeNull();
    expect(t(path.join(root, 'node_modules/x/index.js'))).toBeNull();
    expect(t(path.resolve('/elsewhere/a.ts'))).toBeNull();
    expect(t(path.join(root, 'src/App.vue') + '?vue&type=script')).toBeNull();
    expect(t(path.join(root, 'src/types.d.ts'))).toBeNull();
  });

  it('instruments components (.vue, .svelte, …) compiled by their Vite plugin, at the component\'s lines', async () => {
    const p = make();
    await configured(p, { test: {} });
    // Compiled component: line 1 is the plugin's helper (another source), line 2 maps to App.vue line 8.
    const code = 'let helper = 1;\nlet count = 0;';
    for (const name of ['App.vue', 'App.svelte', 'App.astro']) {
      const m = { version: 3, sources: ['helper.js', path.join(root, 'src', name)], names: [], mappings: 'AAAA;ACOA' };
      const out = p.transform.call({ getCombinedSourcemap: () => m }, code, path.join(root, 'src', name));
      expect(out && out.code).toContain('step(8,');
    }
    const map = { version: 3, sources: ['helper.js', path.join(root, 'src/App.vue')], names: [], mappings: 'AAAA;ACOA' };
    const ctx = { getCombinedSourcemap: () => map };
    const vue = p.transform.call(ctx, code, path.join(root, 'src/App.vue'));
    expect((vue.code.match(/__strace/g) || [])).toHaveLength(1); // the helper line is not the component's
    // No map back to the component: left alone.
    expect(p.transform.call({ getCombinedSourcemap: () => undefined }, code, path.join(root, 'src/App.vue'))).toBeNull();
    // Styles and other assets are not code.
    expect(p.transform.call(ctx, 'export default ".a{}"', path.join(root, 'src/app.css'))).toBeNull();
  });

  it('writes the module graph when Vitest closes its server: project files and their importers, any type', async () => {
    const fs = require('fs'); const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-graph-'));
    process.env.LTR_VITEST_DEPS = path.join(dir, 'deps');
    try {
      const p = make();
      await configured(p, { test: {} });
      const f = (x: string) => path.join(root, 'src', x).replace(/\\/g, '/');
      const mod = (file: string, importers: string[]) => ({ file, importers: new Set(importers.map((i) => ({ file: i }))) });
      const graph = { fileToModulesMap: new Map<string, unknown[]>([
        [f('card.html'), [mod(f('card.html'), [f('card.ts')])]],
        [f('banner.html'), [mod(f('banner.html'), [f('banner.html')]), mod(f('banner.html'), [f('banner.test.ts')])]],
        [path.join(root, 'node_modules/x/index.js').replace(/\\/g, '/'), [mod('x', [f('card.ts')])]],
      ]) };
      p.configureServer({ environments: { ssr: { moduleGraph: graph } } });
      p.closeBundle();
      p.closeBundle(); // once per server
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      const { importers } = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      expect(importers).toEqual({ [f('card.html')]: [f('card.ts')], [f('banner.html')]: [f('banner.test.ts')] });
    } finally {
      delete process.env.LTR_VITEST_DEPS;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no extension list: any compiled module whose map leads back to it; assets never', async () => {
    const p = ltrTracePlugin({ setupFile, parser: require.resolve('@babel/parser'), projectRoot: root, nonSourceExtensions: ['css', 'yml'] });
    await configured(p, { test: {} });
    const own = (file: string) => ({ getCombinedSourcemap: () => ({ version: 3, sources: [path.basename(file)], names: [], mappings: 'AAAA' }) });
    for (const name of ['A.riot', 'A.coffee', 'A.mdx', 'A.whatever']) {
      const file = path.join(root, 'src', name);
      expect(p.transform.call(own(file), 'let a = 1;', file)).not.toBeNull();
    }
    // A map that leads elsewhere (a virtual module, generated code): not this file's lines.
    const other = { getCombinedSourcemap: () => ({ version: 3, sources: ['virtual:thing'], names: [], mappings: 'AAAA' }) };
    expect(p.transform.call(other, 'let a = 1;', path.join(root, 'src/A.mdx'))).toBeNull();
    for (const name of ['a.css', 'a.yml']) {
      const file = path.join(root, 'src', name);
      expect(p.transform.call(own(file), 'export default 1;', file)).toBeNull();
    }
  });

  it('only the first copy in a config works (a project can inherit it and get it added)', async () => {
    const a = make();
    const b = make();
    await a.config.handler({ test: {} });
    a.configResolved({ root, plugins: [a, b], test: {} });
    b.configResolved({ root, plugins: [a, b], test: {} });
    expect(a.transform('let x = 1;', path.join(root, 'a.js'))).not.toBeNull();
    expect(b.transform('let x = 1;', path.join(root, 'a.js'))).toBeNull();
  });

  it('puts a project wrapper\'s root back (Vitest passes the wrapper\'s folder)', async () => {
    const p = ltrTracePlugin({ setupFile, parser: require.resolve('@babel/parser'), projectRoot: root, forceRoot: '/proj/packages/lib' });
    const c = { root: '/tmp/session/project-1', test: {} };
    await p.config.handler(c);
    expect(c.root).toBe('/proj/packages/lib');
  });
});
