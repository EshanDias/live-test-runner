// Both configs list *.test.js and nothing here says which framework it uses:
// it runs with the project's main framework (Jest) and one WARN names the setting.
test('framework-neutral', () => {
  expect(typeof describe).toBe('function');
});
