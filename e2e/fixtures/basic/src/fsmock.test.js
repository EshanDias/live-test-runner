// Learnt from vscode-jest: tests that mock fs must not break the extension's
// own coverage / trace writing (which runs inside the same module registry).
jest.mock('fs');
const fs = require('fs');
const { greet } = require('./strings');

test('fs is mocked in this file', () => {
  fs.readFileSync.mockReturnValue('mocked');
  expect(fs.readFileSync('anything')).toBe('mocked');
  expect(greet('fs')).toBe('Hello, fs!');
});
