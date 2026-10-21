import * as path from 'path';
import { describeAdapterConformance, ProjectFixture } from './adapterConformance';
import { JestAdapter } from '../src/framework/adapters/JestAdapter';
import { CRAAdapter } from '../src/framework/adapters/CRAAdapter';

/** A local Jest install, so the runner resolves `node_modules/jest/bin/jest.js`. */
const jestInstall = {
  'node_modules/jest/package.json': JSON.stringify({ name: 'jest', bin: './bin/jest.js' }),
  'node_modules/jest/bin/jest.js': '',
};

/** A `jest --json` result for `file`: "math adds" passes, "math divides" fails. */
const jestJson = (file: string) => (root: string) => JSON.stringify({
  testResults: [{
    name: path.join(root, file),
    status: 'failed',
    assertionResults: [
      { ancestorTitles: ['math'], title: 'adds', fullName: 'math adds', status: 'passed', failureMessages: [] },
      { ancestorTitles: ['math'], title: 'divides', fullName: 'math divides', status: 'failed', failureMessages: ['Error: boom'] },
    ],
  }],
});

const vitestOnly: ProjectFixture = { pkg: { devDependencies: { vitest: '3' } } };
const cra: ProjectFixture = { pkg: { dependencies: { 'react-scripts': '5' } } };

describeAdapterConformance({
  name: 'jest',
  createAdapter: () => new JestAdapter(),
  matching: [
    { pkg: { devDependencies: { jest: '30' } } },
    { pkg: {}, files: { 'jest.config.ts': '' } },
    { pkg: { jest: { testEnvironment: 'node' } } },
  ],
  notMatching: [vitestOnly, { pkg: { devDependencies: { mocha: '10' } } }],
  runnable: { pkg: { devDependencies: { jest: '30' } }, files: jestInstall },
  canned: { raw: jestJson('src/math.test.js'), file: 'src/math.test.js', passed: 'math adds', failed: 'math divides' },
});

describeAdapterConformance({
  name: 'cra',
  createAdapter: () => new CRAAdapter(),
  matching: [cra, { pkg: { scripts: { test: 'react-scripts test --resetMocks' } } }],
  notMatching: [vitestOnly, { pkg: { devDependencies: { jest: '30' } } }],
  runnable: { ...cra, files: jestInstall },
  // Extracting CRA's config runs react-scripts — stub it.
  prepareRun: (root) => {
    jest.spyOn(CRAAdapter.prototype, 'resolveConfig').mockResolvedValue(path.join(root, 'cra-config.json'));
  },
  canned: { raw: jestJson('src/App.test.js'), file: 'src/App.test.js', passed: 'math adds', failed: 'math divides' },
});
