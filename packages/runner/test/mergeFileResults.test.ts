import { mergeByFile, mergeFileResults } from '../src/parsing/mergeFileResults';
import { FileRunResult, TestCaseRunResult } from '../src/types';

const tc = (fullName: string, status: TestCaseRunResult['status'], failure?: string): TestCaseRunResult => ({
  ancestorTitles: [], title: fullName, fullName, status, failureMessages: failure ? [failure] : [],
});
const file = (cases: TestCaseRunResult[], extra: Partial<FileRunResult> = {}): FileRunResult => ({
  testFilePath: '/p/a.test.js',
  status: cases.some((c) => c.status === 'failed') ? 'failed' : 'passed',
  testCases: cases,
  consoleOutput: [],
  ...extra,
});

describe('mergeFileResults — one file reported by several Jest projects', () => {
  it('a failure in either project fails the test and the file', () => {
    const m = mergeFileResults(file([tc('x', 'passed'), tc('y', 'passed')]), file([tc('x', 'failed', 'jsdom: boom'), tc('y', 'passed')]));
    expect(m.status).toBe('failed');
    expect(m.testCases.map((c) => c.status)).toEqual(['failed', 'passed']);
    expect(m.testCases[0].failureMessages).toEqual(['jsdom: boom']);
  });

  it('keeps failure messages from both projects', () => {
    const m = mergeFileResults(file([tc('x', 'failed', 'node')]), file([tc('x', 'failed', 'jsdom')]));
    expect(m.testCases[0].failureMessages).toEqual(['node', 'jsdom']);
  });

  it('a test that ran beats one that was skipped', () => {
    const m = mergeFileResults(file([tc('x', 'pending')]), file([tc('x', 'passed')]));
    expect(m.testCases[0].status).toBe('passed');
  });

  it('pairs duplicate names in order and appends tests only one project ran', () => {
    const m = mergeFileResults(
      file([tc('d', 'passed'), tc('d', 'passed')]),
      file([tc('d', 'passed'), tc('d', 'failed', 'second'), tc('only-b', 'passed')]),
    );
    expect(m.testCases.map((c) => `${c.fullName}:${c.status}`)).toEqual(['d:passed', 'd:failed', 'only-b:passed']);
  });

  it('combines console output, file failures and durations', () => {
    const log = (message: string) => ({ message, type: 'log', origin: '' });
    const m = mergeFileResults(
      file([], { consoleOutput: [log('a')], duration: 10, failureMessage: 'A' }),
      file([], { consoleOutput: [log('b')], duration: 5, failureMessage: 'B' }),
    );
    expect(m.consoleOutput.map((c) => c.message)).toEqual(['a', 'b']);
    expect(m.duration).toBe(15);
    expect(m.failureMessage).toBe('A\n\nB');
  });

  it('mergeByFile leaves distinct files alone', () => {
    const other = { ...file([tc('z', 'passed')]), testFilePath: '/p/b.test.js' };
    const merged = mergeByFile([file([tc('x', 'passed')]), other, file([tc('x', 'failed', 'f')])]);
    expect(merged.map((f) => `${f.testFilePath}:${f.status}`)).toEqual(['/p/a.test.js:failed', '/p/b.test.js:passed']);
  });
});
