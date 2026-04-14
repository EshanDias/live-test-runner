import { JestRunner } from '../JestRunner';

// Mock the Executor and ResultParser to avoid actual process runs
jest.mock('../execution/Executor');
jest.mock('../parsing/ResultParser');

describe('JestRunner', () => {
  let runner: JestRunner;
  let mockExecutor: any;

  beforeEach(() => {
    runner = new JestRunner();
    mockExecutor = (runner as any).executor;
    mockExecutor.runWithJsonCapture.mockResolvedValue({
      passed: true,
      jsonOutput: '{}',
      stderr: ''
    });
    
    // Mock requireAdapter and requireProjectRoot
    (runner as any).adapter = {
      getExtraArgs: jest.fn(() => []),
      resolveBinary: jest.fn(() => 'jest'),
      resolveConfig: jest.fn(() => 'jest.config.js')
    };
    (runner as any).projectRoot = '/test/root';
  });

  it('should add --updateSnapshot to runTestCaseJson when flag is true', async () => {
    await runner.runTestCaseJson('test1.js', 'my test', false, true);
    
    const callArgs = mockExecutor.runWithJsonCapture.mock.calls[0][0].args;
    expect(callArgs).toContain('--updateSnapshot');
  });

  it('should NOT add --updateSnapshot to runTestCaseJson when flag is false', async () => {
    await runner.runTestCaseJson('test1.js', 'my test', false, false);
    
    const callArgs = mockExecutor.runWithJsonCapture.mock.calls[0][0].args;
    expect(callArgs).not.toContain('--updateSnapshot');
  });

  it('should add --updateSnapshot to runTestFileJson when flag is true', async () => {
    await runner.runTestFileJson('test1.js', true);
    
    const callArgs = mockExecutor.runWithJsonCapture.mock.calls[0][0].args;
    expect(callArgs).toContain('--updateSnapshot');
  });
});
