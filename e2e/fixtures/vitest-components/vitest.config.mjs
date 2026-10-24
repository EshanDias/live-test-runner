import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Vue and Svelte single-file components, compiled by their Vite plugins:
// the execution trace and Vitest's coverage must reach them.
export default defineConfig({
  plugins: [vue(), svelte()],
  // Svelte 5's client build (mount) under jsdom.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: { environment: 'jsdom' },
});
