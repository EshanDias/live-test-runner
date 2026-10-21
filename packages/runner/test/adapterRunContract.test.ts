// Jest and CRA: see adapterConformance.test.ts. These cover the parts the
// conformance suite does not: the Vite placeholder and the result helpers.
import { ViteAdapter, UnsupportedFrameworkError } from '../src/framework/adapters/ViteAdapter';
import { emptyRunResult, mergeRunResults } from '../src/parsing/runResults';

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
