module.exports = {
  testEnvironment: 'node',
  // Every source file counts, tested or not (files no test loads show 0%).
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js'],
};
