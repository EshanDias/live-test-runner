import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toInputConfig, pickGlobalConfig, testScriptJestArgs, testScriptNodeOptions, jestNodeEnv, npmrcNodeOptions, jestEsmHint } from '../src/framework/jestConfig';
import { toJestPathArg } from '../src/JestRunner';
import { stripAnsi } from '../src/utils/logger';

describe('toInputConfig', () => {
  it('turns normalized tuples back into objects and keeps transformer options (BUG-20)', () => {
    const out = toInputConfig({
      cwd: '/p',
      rootDir: '/p',
      transform: [
        ['^.+\\.tsx?$', '/p/node_modules/ts-jest/dist/index.js', { tsconfig: 'tests/tsconfig.json' }],
        ['\\.[jt]sx?$', '/p/node_modules/babel-jest/build/index.js', {}],
      ],
      moduleNameMapper: [['^@lib/(.*)$', '/p/src/lib/$1']],
      silent: true,
    }, ['silent']);
    expect(out).toEqual({
      rootDir: '/p',
      transform: {
        '^.+\\.tsx?$': ['/p/node_modules/ts-jest/dist/index.js', { tsconfig: 'tests/tsconfig.json' }],
        '\\.[jt]sx?$': '/p/node_modules/babel-jest/build/index.js',
      },
      moduleNameMapper: { '^@lib/(.*)$': '/p/src/lib/$1' },
    });
  });

  it('keeps only the global options that affect test runs', () => {
    expect(pickGlobalConfig({ testTimeout: 10000, globalSetup: '/g.js', verbose: true, maxWorkers: 4 }))
      .toEqual({ testTimeout: 10000, globalSetup: '/g.js' });
  });
});

describe('testScriptJestArgs', () => {
  let dir: string;
  const withScript = (test: string) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test } }));
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-script-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('picks behaviour flags from react-scripts test, ignoring run-control flags', () => {
    withScript('react-scripts test --resetMocks --bail --watchAll --env=jsdom');
    expect(testScriptJestArgs(dir)).toEqual(['--resetMocks', '--env', 'jsdom']);
  });

  it('resolves --config relative to the project (BUG-07)', () => {
    fs.writeFileSync(path.join(dir, 'jest.unit.js'), 'module.exports = {}');
    withScript('cross-env FOO=1 jest -c jest.unit.js --coverage && echo done');
    expect(testScriptJestArgs(dir)).toEqual(['--config', path.join(dir, 'jest.unit.js')]);
  });

  it('ignores scripts that do not run Jest, and missing config files', () => {
    withScript('vitest run --config vite.config.ts');
    expect(testScriptJestArgs(dir)).toEqual([]);
    withScript('jest --config missing.js');
    expect(testScriptJestArgs(dir)).toEqual([]);
  });
});

describe('toJestPathArg', () => {
  it('uses forward slashes and an upper-case drive letter (BUG-13)', () => {
    expect(toJestPathArg('c:\\Users\\a b\\x.test.js')).toBe('C:/Users/a b/x.test.js');
    expect(toJestPathArg('/home/a/x.test.js')).toBe('/home/a/x.test.js');
  });
});

describe('stripAnsi', () => {
  it('removes colour codes (BUG-02)', () => {
    expect(stripAnsi('\u001b[31m✕ failed\u001b[39m')).toBe('✕ failed');
  });
});

describe('testScriptNodeOptions (Jest ESM mode)', () => {
  let dir: string;
  /** A home folder of our own: the developer's ~/.npmrc must not leak into the tests. */
  let home: string;
  const withScript = (test: string) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test } }));
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-nodeopts-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-home-'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  it('reads NODE_OPTIONS=… before jest, quoted or not, also behind cross-env', () => {
    withScript('NODE_OPTIONS=--experimental-vm-modules jest');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--experimental-vm-modules']);
    withScript('cross-env NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --coverage');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--experimental-vm-modules', '--no-warnings']);
  });

  it('reads node flags of `node --flag …/jest`', () => {
    withScript('node --experimental-vm-modules node_modules/jest/bin/jest.js');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--experimental-vm-modules']);
  });

  it('keeps only loading-related flags NODE_OPTIONS accepts, and only for the Jest command', () => {
    withScript('NODE_OPTIONS=--inspect-brk jest');
    expect(testScriptNodeOptions(dir, home)).toEqual([]);
    withScript('NODE_OPTIONS=--experimental-vm-modules tsc && jest');
    expect(testScriptNodeOptions(dir, home)).toEqual([]);
    withScript('vitest run');
    expect(testScriptNodeOptions(dir, home)).toEqual([]);
  });

  it('jestNodeEnv adds them to the NODE_OPTIONS already set, once', () => {
    withScript('NODE_OPTIONS=--experimental-vm-modules jest');
    expect(jestNodeEnv(dir, '--max-old-space-size=4096', home)).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096 --experimental-vm-modules' });
    expect(jestNodeEnv(dir, '--experimental-vm-modules', home)).toEqual({ NODE_OPTIONS: '--experimental-vm-modules' });
    withScript('jest');
    expect(jestNodeEnv(dir, '', home)).toBeUndefined();
  });

  it('.npmrc node-options (npm and pnpm pass them to npm test): the project\'s, the monorepo root\'s, else the user\'s', () => {
    withScript('jest');
    fs.writeFileSync(path.join(home, '.npmrc'), 'node-options=--max-old-space-size=2048\n');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--max-old-space-size=2048']);
    fs.writeFileSync(path.join(dir, '.npmrc'), '# comment\nregistry=https://example.org\nnode-options="--experimental-vm-modules --no-warnings"\n');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--experimental-vm-modules', '--no-warnings']);
    // A package of a monorepo: the root's .npmrc.
    const pkg = path.join(dir, 'packages', 'a');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    expect(npmrcNodeOptions(pkg, home)).toEqual(['--experimental-vm-modules', '--no-warnings']);
  });

  it('.npmrc flags only count for a script that runs Jest, and only the allowed ones', () => {
    fs.writeFileSync(path.join(dir, '.npmrc'), 'node-options=--inspect --experimental-vm-modules\n');
    withScript('vitest run');
    expect(testScriptNodeOptions(dir, home)).toEqual([]);
    withScript('jest');
    expect(testScriptNodeOptions(dir, home)).toEqual(['--experimental-vm-modules']);
  });
});

describe('jestEsmHint', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-esmhint-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-home-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'jest' } }));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

  it('an ES module the project wrote: the ESM-mode flag and where it goes', () => {
    const h = jestEsmHint('SyntaxError: Cannot use import statement outside a module\n  at src/a.test.js:1', dir, home);
    expect(h?.kind).toBe('esm-mode');
    expect(h?.text).toMatch(/NODE_OPTIONS=--experimental-vm-modules/);
    expect(h?.text).toMatch(/\.npmrc/);
  });

  it('a package in node_modules: transformIgnorePatterns (and ESM mode while it is off)', () => {
    const msg = "Jest encountered an unexpected token\n /p/node_modules/lib/index.js:1\n export default 1;\n SyntaxError: Unexpected token 'export'";
    const h = jestEsmHint(msg, dir, home);
    expect(h?.kind).toBe('node-modules');
    expect(h?.text).toMatch(/transformIgnorePatterns/);
    expect(h?.text).toMatch(/ESM mode/);
  });

  it('nothing for other errors, or for an ES module error once ESM mode is on', () => {
    expect(jestEsmHint('Cannot find module ./x', dir, home)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'NODE_OPTIONS=--experimental-vm-modules jest' } }));
    expect(jestEsmHint('SyntaxError: Cannot use import statement outside a module', dir, home)).toBeUndefined();
  });
});
