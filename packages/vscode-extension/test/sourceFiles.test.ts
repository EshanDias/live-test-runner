import { extensionOf, isCompiledFile, isSourceFile, scriptOf, sourceFileGlob } from '../src/session/sourceFiles';

/** Which files are source code, whatever the UI framework (React, Vue, Svelte, Astro, …). */

it('JS / TS and compiled formats are source files; assets and docs are not', () => {
  for (const f of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cts', 'App.vue', 'Card.svelte', 'Page.astro', 'x.marko', 'store.svelte.ts',
    'doc.mdx', 'tag.riot', 'a.coffee', 'a.civet', 'Comp.gjs', 'Comp.gts', 'Main.elm', 'a.imba']) {
    expect(isSourceFile(`/p/src/${f}`)).toBe(true);
  }
  for (const f of ['a.css', 'a.scss', 'README.md', 'data.json', 'index.html', 'logo.svg', 'a.vue.snap', 'yarn.lock', '.env']) {
    expect(isSourceFile(`/p/src/${f}`)).toBe(false);
  }
  expect(sourceFileGlob()).toMatch(/^\*\*\/\*\.\{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro,marko,mdx,/);
});

it('the framework can add extensions (Jest\'s moduleFileExtensions, e.g. html for Angular)', () => {
  expect(isSourceFile('/p/app.component.html')).toBe(false);
  expect(isSourceFile('/p/app.component.html', new Set(['html']))).toBe(true);
  expect(isSourceFile('/p/A.HTML', new Set(['html']))).toBe(true);
});

it('compiled = not JS / TS and not an asset; extensionOf is lower case', () => {
  expect(isCompiledFile('/p/App.vue')).toBe(true);
  expect(isCompiledFile('/p/a.whatever')).toBe(true);
  expect(isCompiledFile('/p/app.ts')).toBe(false);
  expect(isCompiledFile('/p/a.css')).toBe(false);
  expect(extensionOf('C:\\p\\B.Vue')).toBe('vue');
  expect(extensionOf('/p/Makefile')).toBe('');
});

describe('scriptOf', () => {
  it('keeps <script> blocks at their own lines and blanks the markup', () => {
    const vue = [
      '<template>',
      '  <p>{{ a }}</p>',
      '</template>',
      '<script setup lang="ts">',
      'const a = 1;',
      '</script>',
      '<style>p { color: red }</style>',
    ].join('\n');
    const out = scriptOf('/p/A.vue', vue);
    const lines = out.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[4]).toBe('const a = 1;');
    expect(out.replace(/\s/g, '')).toBe('consta=1;');
  });

  it('keeps every script block (Svelte module + instance) and Astro frontmatter', () => {
    const svelte = '<script context="module">export const x = 1;</script>\n<script>\nlet y = 2;\n</script>\n<p>{y}</p>';
    expect(scriptOf('/p/A.svelte', svelte).replace(/\s+/g, ' ').trim()).toBe('export const x = 1; let y = 2;');
    const astro = '---\nconst title = "t";\n---\n<h1>{title}</h1>';
    expect(scriptOf('/p/A.astro', astro).split('\n')[1]).toBe('const title = "t";');
  });

  it('leaves JS / TS untouched', () => {
    expect(scriptOf('/p/a.ts', 'const <T>() => 1')).toBe('const <T>() => 1');
  });
});
