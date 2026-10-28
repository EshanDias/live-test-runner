import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Plain JS module, run as-is (it is bundled into the extension).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { discoverTests, setLogger } = require('../src/session/instrumentation/shared/testDiscovery.js') as {
  discoverTests(code: string, file: string, root: string): Result | null;
  setLogger(log: unknown): void;
};

interface TestEntry { name: string; line: number; fullName: string }
interface Suite { name: string; line: number; tests: TestEntry[]; children: Suite[] }
interface Result { suites: Suite[]; rootTests: TestEntry[] }

/** Every test's fullName and line, depth first, in source order. */
function flat(r: Result | null): string[] {
  if (!r) { return ['<null>']; }
  const out: string[] = [];
  const walk = (s: Suite) => {
    out.push(`[${s.name}]:${s.line}`);
    for (const t of s.tests) { out.push(`${t.fullName}:${t.line}`); }
    s.children.forEach(walk);
  };
  r.suites.forEach(walk);
  for (const t of r.rootTests) { out.push(`${t.fullName}:${t.line}`); }
  return out;
}

// A folder with no Babel: discovery uses the extension's own parser + walker,
// as it does for a Vitest project.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-discovery-'));
const discover = (code: string) => flat(discoverTests(code, path.join(root, 'a.test.ts'), root));

beforeAll(() => setLogger({ debug: () => {}, warn: () => {}, error: () => {} }));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('static test discovery — Jest forms (unchanged)', () => {
  it('finds nested suites, modifiers and .each, in source order', () => {
    expect(discover([
      "describe('outer', () => {",
      "  it('a', () => {});",
      "  describe.skip('inner', () => {",
      "    test.only('b', () => {});",
      "    it.concurrent.each([1])('c %i', () => {});",
      '  });',
      '  test.each`x\\n${1}`("d $x", () => {});',
      '});',
      "test('top', () => {});",
    ].join('\n'))).toEqual([
      '[outer]:1', 'outer a:2', 'outer d $x:7', '[inner]:3', 'outer inner b:4', 'outer inner c %i:5', 'top:9',
    ]);
  });

  it('nests the tests of describe.each([...])(name, fn) under it', () => {
    expect(discover("describe.each([[1], [2]])('row %i', () => {\n  it('t', () => {});\n});\ntest('after', () => {});"))
      .toEqual(['[row %i]:1', 'row %i t:2', 'after:4']);
  });

  it('parses generic arrow functions in .ts files (no JSX there)', () => {
    expect(discover("const id = <T>(x: T): T => x;\ntest('generic', () => { id(1); });")).toEqual(['generic:2']);
    const tsx = flat(discoverTests("const el = <div />;\ntest('jsx', () => {});", path.join(root, 'a.test.tsx'), root));
    expect(tsx).toEqual(['jsx:2']);
  });

  it('ignores describe / test imported from another package (tstyche)', () => {
    expect(discover("import { test } from 'tstyche';\ntest('type check', () => {});")).toEqual([]);
  });
});

describe('static test discovery — Vitest forms', () => {
  it('accepts imports from vitest', () => {
    expect(discover("import { describe, it } from 'vitest';\ndescribe('s', () => { it('t', () => {}); });"))
      .toEqual(['[s]:2', 's t:2']);
  });

  it('reads .for, .skipIf and .runIf like .each', () => {
    expect(discover([
      "import { describe, test } from 'vitest';",
      "test.for([1, 2])('for %i', () => {});",
      "test.skipIf(process.env.CI)('skip on CI', () => {});",
      "test.runIf(true)('run if', () => {});",
      "describe.skipIf(false)('suite', () => { test('inside', () => {}); });",
      'test.for`a\\n${1}`("tagged $a", () => {});',
    ].join('\n'))).toEqual([
      '[suite]:5', 'suite inside:5', 'for %i:2', 'skip on CI:3', 'run if:4', 'tagged $a:6',
    ]);
  });

  it('keeps sequential / concurrent / fails / todo modifiers', () => {
    expect(discover([
      "describe.sequential('seq', () => {",
      "  test.concurrent('c', async () => {});",
      "  test.fails('f', () => { throw 1; });",
      "  test.todo('later');",
      '});',
    ].join('\n'))).toEqual(['[seq]:1', 'seq c:2', 'seq f:3', 'seq later:4']);
  });

  it('treats suite imported from vitest as describe', () => {
    expect(discover("import { suite, test } from 'vitest';\nsuite('S', () => { test('t', () => {}); });"))
      .toEqual(['[S]:2', 'S t:2']);
  });

  it('finds tests of fixtures made with test.extend, chained and typed', () => {
    expect(discover([
      "import { test as base, expect } from 'vitest';",
      'const withDb = base.extend<{ db: string }>({ db: async ({}, use) => use("x") });',
      'export const myTest = withDb.extend({ page: async ({}, use) => use(1) }).extend({});',
      "withDb('db test', ({ db }) => { expect(db).toBe('x'); });",
      "myTest('page test', () => {});",
      "myTest.skip('skipped', () => {});",
    ].join('\n'))).toEqual(['db test:4', 'page test:5', 'skipped:6']);
  });

  it("accepts test / it imported from the project's own fixtures module", () => {
    expect(discover("import { test } from './fixtures';\ntest('uses a fixture', ({ page }) => {});")).toEqual(['uses a fixture:2']);
    expect(discover("import { it } from '@/test/setup';\nit('aliased', () => {});")).toEqual(['aliased:2']);
  });

  it('ignores bench', () => {
    expect(discover("import { bench, describe } from 'vitest';\ndescribe('perf', () => { bench('loop', () => {}); });"))
      .toEqual(['[perf]:2']);
  });

  it('does not treat a plain `suite` (not from vitest) as describe', () => {
    expect(discover("suite('mocha style', () => {});")).toEqual([]);
  });
});

describe('parsing with an older or newer Babel than the plugin list expects', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { _parseDroppingRemoved } = require('../src/session/instrumentation/shared/testDiscovery.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('@babel/parser');
  /** Babel 8's parser: some proposals and options are gone. */
  const babel8 = {
    parse(code: string, options: { plugins: unknown[] }) {
      const names = options.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
      if (names.includes('decimal')) { throw new Error("The 'decimal' plugin has been removed in Babel 8. Please remove it from your configuration."); }
      if (names.includes('importAssertions')) { throw new Error('`importAssertions` has been removed in Babel 8, please use import attributes instead.'); }
      if (names.includes('pipelineOperator')) { throw new Error('"pipelineOperator" requires "proposal" option whose value must be one of: "fsharp", "hack".'); }
      return real.parse(code, options);
    },
  };

  it('drops only the plugins the parser rejects — decorators and TypeScript still apply (Angular specs)', () => {
    const code = "@Component({ selector: 'a' })\nclass A { constructor(private x: number) {} }\ndescribe('s', () => { it('t', () => {}); });";
    const ast = _parseDroppingRemoved(babel8, code, {
      sourceType: 'module',
      plugins: ['typescript', 'decimal', ['decorators', { version: '2023-11' }], 'importAssertions', ['pipelineOperator', { proposal: 'minimal' }]],
    });
    expect(ast.program.body).toHaveLength(2);
  });

  it('a syntax error is not a plugin problem: it still throws', () => {
    expect(() => _parseDroppingRemoved(babel8, 'let = ;', { sourceType: 'module', plugins: ['typescript'] })).toThrow();
  });
});
