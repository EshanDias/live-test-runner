// A package migrating to Vitest: Jest runs *.test.js, Vitest runs *.vitest.js.
module.exports = { testEnvironment: 'node', testMatch: ['<rootDir>/src/**/*.test.js'] };
