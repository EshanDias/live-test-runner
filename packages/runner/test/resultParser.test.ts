import { ResultParser } from '../src/parsing/ResultParser';

describe('ResultParser', () => {
  it('reads the file path from `name`, as Jest --json writes it', () => {
    const json = JSON.stringify({
      testResults: [{
        name: '/p/src/config.test.js',
        status: 'passed',
        startTime: 1000,
        endTime: 1250,
        assertionResults: [{ ancestorTitles: [], title: 't', fullName: 't', status: 'passed', duration: 3, failureMessages: [] }],
      }],
    });
    const result = new ResultParser().parse(true, json, '');
    expect(result.fileResults[0].testFilePath).toBe('/p/src/config.test.js');
    expect(result.fileResults[0].duration).toBe(250);
  });
});
