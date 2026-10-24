// Jest runs *.test.js and its own *.jest.js files.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.js', '<rootDir>/src/**/*.jest.js'],
};
