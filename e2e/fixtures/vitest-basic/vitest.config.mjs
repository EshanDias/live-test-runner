import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // The extension must replace this with its JSON reporter (vueuse uses 'dot').
    reporters: ['dot'],
  },
});
