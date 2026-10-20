import { JestAdapter } from '../src/framework/adapters/JestAdapter';
import { CRAAdapter } from '../src/framework/adapters/CRAAdapter';
import { ViteAdapter, UnsupportedFrameworkError } from '../src/framework/adapters/ViteAdapter';
import { JestRunner } from '../src/JestRunner';
import { emptyRunResult, mergeRunResults } from '../src/parsing/runResults';

const jestJson = JSON.stringify({
  testResults: [{
    name: '/p/a.test.js',
    status: 'failed',
    assertionResults: [{ ancestorTitles: [], title: 't', fullName: 't', status: 'failed', failureMessages: ['boom'] }],
  }],
});

describe.each([['jest', new JestAdapter()], ['cra', new CRAAdapter()]])('%s adapter — running', (_, adapter) => {
  it('names the result file with --outputFile', () => {
    expect(adapter.outputFileArg('/tmp/r.json')).toEqual(['--outputFile=/tmp/r.json']);
  });

  it('parses a jest --json result', () => {
    const r = adapter.parseResult(false, jestJson, '');
    expect(r.fileResults[0].testFilePath).toBe('/p/a.test.js');
    expect(r.fileResults[0].testCases[0].status).toBe('failed');
  });

  it('creates a JestRunner', () => {
    expect(adapter.createRunner({ command: 'npm test --' })).toBeInstanceOf(JestRunner);
  });
});

describe('vite adapter — running', () => {
  it('is not supported yet', () => {
    const adapter = new ViteAdapter();
    expect(() => adapter.outputFileArg('/tmp/r.json')).toThrow(UnsupportedFrameworkError);
    expect(() => adapter.parseResult(true, '{}', '')).toThrow(UnsupportedFrameworkError);
    expect(() => adapter.createRunner()).toThrow(UnsupportedFrameworkError);
  });
});

describe('run results', () => {
  it('merges chunked runs', () => {
    const a = { ...emptyRunResult(true, []), numPassedTests: 2 };
    const b = { ...emptyRunResult(false, ['x']), numFailedTests: 1 };
    expect(mergeRunResults([a, b])).toEqual({
      passed: false, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, fileResults: [], errors: ['x'],
    });
  });
});
