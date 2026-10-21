// Jest and CRA: see adapterConformance.test.ts. These cover the parts the
// conformance suite does not: Vitest before its runner exists, the Jest
// runner refusing other frameworks, and the result helpers.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestAdapter } from '../src/framework/adapters/VitestAdapter';
import { UnsupportedFrameworkError } from '../src/framework/UnsupportedFrameworkError';
import { JestRunner } from '../src/JestRunner';
import { Executor } from '../src/execution/Executor';
import { emptyRunResult, mergeRunResults } from '../src/parsing/runResults';
import { setLogSink } from '../src/utils/logger';

describe('vitest adapter — running', () => {
  it('has no runner yet (task 2.2)', () => {
    expect(() => new VitestAdapter().createRunner()).toThrow(UnsupportedFrameworkError);
  });

  it('writes its json result to --outputFile', () => {
    expect(new VitestAdapter().outputFileArg('/tmp/r.json')).toEqual(['--outputFile=/tmp/r.json']);
  });
});

describe('JestRunner on a Vitest project', () => {
  let dir: string;
  beforeAll(() => {
    setLogSink(() => {});
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr refuse ')));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '5' } }));
  });
  afterAll(() => { setLogSink(undefined); fs.rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => jest.restoreAllMocks());

  it('accepts the project root, then refuses to run it with Jest flags', async () => {
    const spy = jest.spyOn(Executor.prototype, 'runWithJsonCapture');
    const runner = new JestRunner();
    expect(() => runner.setProjectRoot(dir)).not.toThrow();
    await expect(runner.runTestFileJson(path.join(dir, 'a.test.ts'))).rejects.toThrow(UnsupportedFrameworkError);
    expect(spy).not.toHaveBeenCalled();
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
