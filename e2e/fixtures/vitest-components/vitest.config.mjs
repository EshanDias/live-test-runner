import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Inlines `card.html` into card.ts the way Angular's Vite plugin inlines a
// component's templateUrl: the template is read from disk, not imported.
const inlineTemplate = {
  name: 'inline-template',
  transform(code, id) {
    if (!id.endsWith('/card.ts')) { return null; }
    const file = path.join(path.dirname(id), 'card.html');
    this.addWatchFile(file);
    return code.replace('__TEMPLATE__', JSON.stringify(fs.readFileSync(file, 'utf8')));
  },
};

// Vue and Svelte single-file components, compiled by their Vite plugins:
// the execution trace and Vitest's coverage must reach them. HTML files
// (a `?raw` import, a template a plugin reads) rerun their tests on save.
export default defineConfig({
  plugins: [vue(), svelte(), inlineTemplate],
  // Svelte 5's client build (mount) under jsdom.
  resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
  test: { environment: 'jsdom' },
});
