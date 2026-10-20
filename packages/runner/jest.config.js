module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: { '\\.[jt]s$': '<rootDir>/../../jest.esbuild.js' },
};
