import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toInputConfig, pickGlobalConfig, testScriptJestArgs, testScriptNodeOptions, jestNodeEnv } from '../src/framework/jestConfig';
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
  const withScript = (test: string) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test } }));
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-nodeopts-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads NODE_OPTIONS=… before jest, quoted or not, also behind cross-env', () => {
    withScript('NODE_OPTIONS=--experimental-vm-modules jest');
    expect(testScriptNodeOptions(dir)).toEqual(['--experimental-vm-modules']);
    withScript('cross-env NODE_OPTIONS="--experimental-vm-modules --no-warnings" npx jest --coverage');
    expect(testScriptNodeOptions(dir)).toEqual(['--experimental-vm-modules', '--no-warnings']);
  });

  it('reads node flags of `node --flag …/jest`', () => {
    withScript('node --experimental-vm-modules node_modules/jest/bin/jest.js');
    expect(testScriptNodeOptions(dir)).toEqual(['--experimental-vm-modules']);
  });

  it('keeps only loading-related flags NODE_OPTIONS accepts, and only for the Jest command', () => {
    withScript('NODE_OPTIONS=--inspect-brk jest');
    expect(testScriptNodeOptions(dir)).toEqual([]);
    withScript('NODE_OPTIONS=--experimental-vm-modules tsc && jest');
    expect(testScriptNodeOptions(dir)).toEqual([]);
    withScript('vitest run');
    expect(testScriptNodeOptions(dir)).toEqual([]);
  });

  it('jestNodeEnv adds them to the NODE_OPTIONS already set, once', () => {
    withScript('NODE_OPTIONS=--experimental-vm-modules jest');
    expect(jestNodeEnv(dir, '--max-old-space-size=4096')).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096 --experimental-vm-modules' });
    expect(jestNodeEnv(dir, '--experimental-vm-modules')).toEqual({ NODE_OPTIONS: '--experimental-vm-modules' });
    withScript('jest');
    expect(jestNodeEnv(dir, '')).toBeUndefined();
  });
});
