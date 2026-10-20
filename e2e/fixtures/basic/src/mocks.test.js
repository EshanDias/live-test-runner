// Learnt from copy-requisition: its test script is `react-scripts test
// --resetMocks`. This project's script is `jest --resetMocks`; the second test
// only passes when that flag is honoured, as `npm test` does.
const spy = jest.fn();

test('mock returns the value set in this test', () => {
  spy.mockReturnValue(1);
  expect(spy()).toBe(1);
});

test('mock implementation is reset before each test (--resetMocks)', () => {
  expect(spy()).toBeUndefined();
});
