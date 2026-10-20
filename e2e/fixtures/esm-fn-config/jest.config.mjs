// An ES module config that exports an async function. The ~lib alias exists
// only here: if the config is not loaded, every test fails to resolve it.
export default async () => ({
  testEnvironment: 'node',
  moduleNameMapper: {
    '^~lib/(.*)$': '<rootDir>/lib/$1',
  },
});
