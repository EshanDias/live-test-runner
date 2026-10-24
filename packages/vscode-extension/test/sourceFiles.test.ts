import { isComponentFile, isSourceFile, scriptOf, sourceFileGlob } from '../src/session/sourceFiles';

/** Which files are source code, whatever the UI framework (React, Vue, Svelte, Astro, …). */

it('JS / TS and single-file components are source files; assets and docs are not', () => {
  for (const f of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cts', 'App.vue', 'Card.svelte', 'Page.astro', 'x.marko', 'store.svelte.ts']) {
    expect(isSourceFile(`/p/src/${f}`)).toBe(true);
  }
  for (const f of ['a.css', 'a.scss', 'README.md', 'data.json', 'index.html', 'logo.svg', 'a.vue.snap']) {
    expect(isSourceFile(`/p/src/${f}`)).toBe(false);
  }
  expect(isComponentFile('/p/App.VUE')).toBe(true);
  expect(isComponentFile('/p/app.ts')).toBe(false);
  expect(sourceFileGlob()).toBe('**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro,marko}');
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
