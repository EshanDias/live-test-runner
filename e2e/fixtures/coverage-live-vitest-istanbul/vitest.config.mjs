import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    // Every source file counts, tested or not (files no test loads show 0%).
    coverage: { provider: 'istanbul', include: ['src/**/*.js'], exclude: ['src/**/*.test.js'] },
  },
});
