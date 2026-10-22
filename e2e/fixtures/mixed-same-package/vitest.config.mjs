// Vitest runs *.test.js too (the conflict the extension settles per file) and its own *.vitest.js files.
export default {
  test: {
    include: ['src/**/*.test.js', 'src/**/*.vitest.js'],
  },
};
