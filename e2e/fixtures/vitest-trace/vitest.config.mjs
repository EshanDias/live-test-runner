import { defineConfig } from 'vitest/config';

// Two projects (Vitest 4): an inline one that extends this config, and a
// folder with its own config — the execution trace must reach both.
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'app', include: ['src/**/*.test.{js,ts}'] } },
      'packages/*',
    ],
  },
});
