import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module from 'module';

/**
 * The Jest session transform rewrites optional chains to count both branches.
 * The rewritten code must behave exactly like the original: above all, a
 * method called through `?.` keeps its object as `this` (Jest's own runtime
 * calls `this._environment.exportConditions?.()`).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const transform = require('../src/session/instrumentation/jest/sessionTraceTransform.js');
const REPO = path.resolve(__dirname, '..', '..', '..');

let dir: string;
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-jtrace-')));
  process.env.LTR_MANIFEST_DIR = path.join(dir, 'manifests');
  // The project's Babel (a Jest project always has it): linked from the repo's store.
  for (const pkg of ['traverse', 'generator', 'types', 'parser']) {
    const real = path.dirname(require.resolve(`@babel/${pkg}/package.json`, { paths: [path.join(REPO, 'node_modules', '.pnpm'), __dirname] }));
    fs.mkdirSync(path.join(dir, 'node_modules', '@babel'), { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'node_modules', '@babel', pkg), 'junction');
  }
});
afterAll(() => {
  delete process.env.LTR_MANIFEST_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs `code` as a CommonJS module, plain or through the session transform. */
function run(code: string, instrumented: boolean): unknown {
  const file = path.join(dir, 'src', 'probe.js');
  const out = instrumented
    ? transform.process(code, file, { config: { rootDir: dir, transform: [] }, cacheFS: new Map(), transformerConfig: {} })
    : code;
  const m = new Module(file) as Module & { _compile(code: string, file: string): void };
  m.paths = (Module as unknown as { _nodeModulePaths(p: string): string[] })._nodeModulePaths(dir);
  m._compile(typeof out === 'string' ? out : out.code, file);
  return m.exports;
}

const PRELUDE = `
class Env { constructor() { this.c = ['x']; } ec(...a) { return [...this.c, ...a]; } }
class Sub extends Env { ec2() { return super.ec?.('s'); } }
const o = { env: new Env(), none: null, k: 'ec', sub: new Sub() };
`;

describe('optional chains keep their meaning', () => {
  it.each([
    'o.env.ec?.()',
    'o.env.ec?.(1, 2)',
    'o.env[o.k]?.()',
    'o.env.missing?.()',
    'o.none?.ec?.()',
    'o.env?.ec?.()',
    'o.env?.ec()',
    '(o.env?.ec)()',
    'o?.env.ec?.()',
    'o.env.ec?.().length',
    'o?.env.ec().length',
    'o.sub.ec2()',
    'o.none?.a.b.c',
    'o.env?.c[0]',
  ])('%s', (expr) => {
    const code = `${PRELUDE}\nmodule.exports = ${expr};`;
    expect(run(code, true)).toEqual(run(code, false));
  });
});

describe('the runtime line keeps the file strict', () => {
  it.each([
    ['"use strict";\nmodule.exports = (function () { return this; })();'],
    ["#!/usr/bin/env node\n// a comment\n'use strict'\n/* more */ module.exports = (function () { return this; })();"],
    ['"use client";\n"use strict";\nmodule.exports = [(function () { return this; })(), Object.isFrozen(Object.freeze({}))];'],
    ['module.exports = (function () { return this === globalThis; })();'],
  ])('%#', (code) => {
    expect(run(code, true)).toEqual(run(code, false));
  });

  it('puts the runtime after "use strict", on the same line (line numbers unchanged)', () => {
    const file = path.join(dir, 'src', 'strict.js');
    const out = transform.process('"use strict";\nconst a = 1;\nmodule.exports = a;\n', file,
      { config: { rootDir: dir, transform: [] }, cacheFS: new Map(), transformerConfig: {} });
    const code: string = typeof out === 'string' ? out : out.code;
    expect(code.startsWith('"use strict";require(')).toBe(true);
  });

  it('errors from instrumented code report the source line (stack traces)', () => {
    // A transformer that returns the code as it is: the line numbers seen are the instrumented code's own.
    fs.writeFileSync(path.join(dir, 'passthrough.js'), 'module.exports = { process: (src) => ({ code: src }) };\n');
    const file = path.join(dir, 'src', 'throws.js');
    const src = '"use strict";\nconst a = [1, 2].map((x) => x * 2);\nfunction f(v) {\n  if (v) { throw new Error(`bad ${a}`); }\n  return v;\n}\ntry { f(1); } catch (e) { module.exports = e.stack; }\n';
    const out = transform.process(src, file, {
      config: { rootDir: dir, transform: [['\\.js$', path.join(dir, 'passthrough.js'), {}]] }, cacheFS: new Map(), transformerConfig: {},
    });
    const m = new Module(file) as Module & { _compile(code: string, file: string): void };
    m._compile(out.code, file);
    expect(String(m.exports)).toMatch(/throws\.js:4:/);
  });
});
