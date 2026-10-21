// Jest and CRA: see adapterConformance.test.ts. These cover the parts the
// conformance suite does not: Vitest before its runner exists, the Jest
// runner refusing other frameworks, and the result helpers.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VitestAdapter } from '../src/framework/adapters/VitestAdapter';
import { UnsupportedFrameworkError } from '../src/framework/UnsupportedFrameworkError';
import { JestRunner } from '../src/JestRunner';
import { VitestRunner } from '../src/VitestRunner';
import { Executor } from '../src/execution/Executor';
import { emptyRunResult, mergeRunResults } from '../src/parsing/runResults';
import { setLogSink } from '../src/utils/logger';

describe('vitest adapter — running', () => {
  it('creates a VitestRunner', () => {
    expect(new VitestAdapter().createRunner()).toBeInstanceOf(VitestRunner);
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

describe('VitestRunner on a Jest project', () => {
  let dir: string;
  beforeAll(() => {
    setLogSink(() => {});
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltr refuse jest ')));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '30' } }));
  });
  afterAll(() => { setLogSink(undefined); fs.rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => jest.restoreAllMocks());

  it('accepts the project root, then refuses to run it', async () => {
    const spy = jest.spyOn(Executor.prototype, 'runWithJsonCapture');
    const runner = new VitestRunner();
    expect(() => runner.setProjectRoot(dir)).not.toThrow();
    await expect(runner.runTestFileJson(path.join(dir, 'a.test.js'))).rejects.toThrow(UnsupportedFrameworkError);
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
