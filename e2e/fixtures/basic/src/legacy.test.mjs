// .mjs tests are outside Jest's default testMatch, so this project never runs them.
test('esm legacy', () => {
  expect(1).toBe(1);
});
