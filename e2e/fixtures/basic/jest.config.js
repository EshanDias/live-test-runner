module.exports = {
  testEnvironment: 'node',
  // e2e/ holds browser specs that Jest must never run.
  testPathIgnorePatterns: ['/node_modules/', '/e2e/'],
  // Regression guard for BUG-01: verbose mode used to hide console output.
  verbose: true,
  // Project hooks around every test (see src/setupTests.js).
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.js'],
};
