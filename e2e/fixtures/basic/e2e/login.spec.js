// A browser (Playwright-style) spec. jest.config.js ignores this folder, so
// Live Test Runner must not try to run it as a Jest test.
test('logs in through the browser', () => {
  throw new Error('this is not a Jest test and must never run');
});
