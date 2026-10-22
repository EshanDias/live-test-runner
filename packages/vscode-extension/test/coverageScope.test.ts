import * as path from 'path';
import { defaultCoverageScope, jestCoverageScope, vitestCoverageScope } from '../src/coverage/coverageScope';
import { parseShowConfig } from '../src/session/JestProjectConfig';

const root = path.resolve('/proj');
const abs = (rel: string) => path.join(root, rel);

describe('vitestCoverageScope', () => {
  // As Vitest 5 resolves `coverage: { include: ['src/**/*.{js,jsx}'], exclude: [...] }`.
  const scope = vitestCoverageScope({
    root,
    include: ['src/**/*.{js,jsx}'],
    exclude: ['src/**/*.test.{js,jsx}', 'src/setupTests.js', 'src/index.jsx', '**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/node_modules/**'],
  });

  it('counts only included files', () => {
    expect(scope.counts(abs('src/utils/math.js'))).toBe(true);
    expect(scope.counts(abs('src/components/App.jsx'))).toBe(true);
    expect(scope.counts(abs('src/types/a.ts'))).toBe(false);
    // Generated reports / bundles outside the include list (e.g. the html reporter's .vitest/ folder).
    expect(scope.counts(abs('.vitest/ui/assets/index-abc.js'))).toBe(false);
    expect(scope.counts(abs('public/server.js'))).toBe(false);
  });

  it('leaves out excluded files', () => {
    expect(scope.counts(abs('src/setupTests.js'))).toBe(false);
    expect(scope.counts(abs('src/index.jsx'))).toBe(false);
    expect(scope.counts(abs('src/a/b.test.jsx'))).toBe(false);
  });

  it('keeps folders the built-in rules would drop when the config includes them', () => {
    expect(scope.counts(abs('src/test/helpers.js'))).toBe(true);
  });

  it('counts untouched files only with an include list (and not with all: false)', () => {
    expect(scope.includesUntouched).toBe(true);
    expect(vitestCoverageScope({ root, include: [], exclude: [] }).includesUntouched).toBe(false);
    expect(vitestCoverageScope({ root, include: ['**'], all: false }).includesUntouched).toBe(false);
  });

  it('without an include list counts every loaded file outside exclude and node_modules', () => {
    const s = vitestCoverageScope({ root, exclude: ['**/*.test.js'] });
    expect(s.counts(abs('lib/a.js'))).toBe(true);
    expect(s.counts(abs('lib/a.test.js'))).toBe(false);
    expect(s.counts(abs('node_modules/x/index.js'))).toBe(false);
    expect(s.counts(path.resolve('/elsewhere/a.js'))).toBe(false);
  });
});

describe('jestCoverageScope', () => {
  const base = {
    rootDir: root,
    testMatch: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
    coveragePathIgnorePatterns: ['/node_modules/', '/legacy/'],
    setupFiles: [abs('src/setupTests.js')],
  };

  it('with collectCoverageFrom counts matching files, untouched ones included', () => {
    const s = jestCoverageScope({ ...base, collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!src/**/*.d.ts'] });
    expect(s.includesUntouched).toBe(true);
    expect(s.counts(abs('src/a.ts'))).toBe(true);
    expect(s.counts(abs('src/a.d.ts'))).toBe(false);
    expect(s.counts(abs('scripts/build.js'))).toBe(false);
  });

  it('leaves out test files, setup files, mocks and ignored paths', () => {
    const s = jestCoverageScope(base);
    expect(s.includesUntouched).toBe(false);
    expect(s.counts(abs('src/a.js'))).toBe(true);
    expect(s.counts(abs('src/a.test.js'))).toBe(false);
    expect(s.counts(abs('src/__tests__/a.js'))).toBe(false);
    expect(s.counts(abs('src/setupTests.js'))).toBe(false);
    expect(s.counts(abs('src/__mocks__/x.js'))).toBe(false);
    expect(s.counts(abs('src/legacy/a.js'))).toBe(false);
    expect(s.counts(abs('node_modules/x/a.js'))).toBe(false);
  });

  it('applies testRegex', () => {
    const s = jestCoverageScope({ rootDir: root, testRegex: ['\\.check\\.js$'] });
    expect(s.counts(abs('src/a.check.js'))).toBe(false);
    expect(s.counts(abs('src/a.js'))).toBe(true);
  });
});

describe('defaultCoverageScope', () => {
  it('applies the built-in rules and counts untouched files', () => {
    const s = defaultCoverageScope(root);
    expect(s.isDefault).toBe(true);
    expect(s.includesUntouched).toBe(true);
    expect(s.counts(abs('src/a.js'))).toBe(true);
    expect(s.counts(abs('dist/a.js'))).toBe(false);
  });
});

describe('parseShowConfig coverage settings', () => {
  it('reads collectCoverageFrom and the project rules', () => {
    const r = parseShowConfig(JSON.stringify({
      configs: [{
        rootDir: root,
        testMatch: ['**/*.test.js'],
        testRegex: [],
        coveragePathIgnorePatterns: ['/node_modules/'],
        setupFiles: [abs('a.js')],
        setupFilesAfterEnv: [abs('b.js')],
        globalSetup: null,
      }],
      globalConfig: { rootDir: root, collectCoverageFrom: ['src/**/*.js'] },
      version: '29.7.0',
    }));
    expect(r?.coverage).toEqual({
      rootDir: root,
      collectCoverageFrom: ['src/**/*.js'],
      coveragePathIgnorePatterns: ['/node_modules/'],
      testMatch: ['**/*.test.js'],
      testRegex: [],
      setupFiles: [abs('a.js'), abs('b.js')],
    });
  });
});
