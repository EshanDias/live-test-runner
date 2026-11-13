module.exports = {
  testEnvironment: 'node',
  // Coverage measured by V8, not Babel instrumentation.
  coverageProvider: 'v8',
  // Every source file counts, tested or not (files no test loads show 0%).
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js'],
};
