// Unit tests for modules with no VS Code dependency (store, helpers). The
// extension's behaviour inside VS Code is covered by the e2e suite (e2e/).
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: { '\\.[jt]s$': '<rootDir>/../../jest.esbuild.js' },
};
