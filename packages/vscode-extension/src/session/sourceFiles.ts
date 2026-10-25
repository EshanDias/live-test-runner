/**
 * Which files are a project's source code, whatever UI framework it uses.
 *
 * The rule is the test framework's: a file is source when the framework can
 * load it. Three ways to know (SessionManager combines them on save):
 *   1. this list — JS / TS, and the formats test frameworks compile through
 *      their own transforms (Vite plugins, Jest transformers): Vue, Svelte,
 *      Astro, Marko, MDX, Riot, Imba, CoffeeScript, Civet, Ember's
 *      .gjs / .gts, Elm. React, Preact, Solid, Lit, Angular and Qwik code is
 *      plain .js / .jsx / .ts / .tsx;
 *   2. the project's Jest config (`moduleFileExtensions`, e.g. `html` with
 *      jest-preset-angular) — IProjectConfig.sourceExtensions;
 *   3. the execution trace: a file a test ran, whatever its extension.
 * The list only decides what a save may start: saving a README, an image or
 * a lock file must not start a test run. The Vitest trace itself has no
 * list — it instruments any module that compiled to JavaScript and whose
 * source map leads back to it (vitestTracePlugin.js).
 */

/** Extensions (without the dot) of JS / TS sources. */
export const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'] as const;

/** Extensions (without the dot) of sources a plugin / transformer compiles to JS (components and JS dialects). */
export const COMPILED_EXTENSIONS = [
  'vue', 'svelte', 'astro', 'marko', 'mdx', 'riot', 'imba', 'coffee', 'litcoffee', 'civet', 'gjs', 'gts', 'elm',
] as const;

/**
 * Never source code (assets, data, docs, tooling files) — even when a
 * transform loads them (`import css from './a.css'`, a `?raw` HTML file).
 * Instrumenting them would count non-code in coverage.
 */
export const NON_SOURCE_EXTENSIONS = new Set([
  'css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss', 'sss',
  'json', 'json5', 'jsonc', 'node', 'html', 'htm', 'xml', 'svg', 'md', 'markdown', 'txt', 'csv',
  'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'log', 'map', 'snap',
  'graphql', 'gql', 'glsl', 'wgsl', 'vert', 'frag',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'webm', 'ogg', 'pdf', 'zip', 'wasm',
]);

export const SOURCE_EXTENSIONS: readonly string[] = [...SCRIPT_EXTENSIONS, ...COMPILED_EXTENSIONS];

const SOURCE_RE = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');
const SCRIPT_RE = new RegExp(`\\.(?:${SCRIPT_EXTENSIONS.join('|')})$`, 'i');
/** Components with <script> blocks (scriptOf). */
const SFC_RE = /\.(?:vue|svelte|astro|marko|riot)$/i;

/** The extension without the dot, lower case ('' when none): `a/B.Vue` → `vue`. */
export function extensionOf(filePath: string): string {
  const m = /\.([^./\\]+)$/.exec(filePath);
  return m ? m[1].toLowerCase() : '';
}

/**
 * A source file by the list, or by extensions the project's framework adds
 * (`extra`: e.g. Jest's `moduleFileExtensions`). Type declarations (`.d.ts`) included.
 */
export function isSourceFile(filePath: string, extra?: ReadonlySet<string>): boolean {
  return SOURCE_RE.test(filePath) || (!!extra && extra.has(extensionOf(filePath)));
}

/** Not JS / TS: compiled by a plugin / transformer first (`.vue`, `.svelte`, `.coffee`, …). */
export function isCompiledFile(filePath: string): boolean {
  return !SCRIPT_RE.test(filePath) && !NON_SOURCE_EXTENSIONS.has(extensionOf(filePath));
}

/** VS Code glob for every listed source file, e.g. `**\/*.{js,…,vue,svelte}`. */
export function sourceFileGlob(): string {
  return `**/*.{${SOURCE_EXTENSIONS.join(',')}}`;
}

/**
 * The script of a component as one JS / TS text with the component's own
 * line numbers: every `<script>` block (Vue, Svelte, Astro, Marko, Riot),
 * and Astro's `---` frontmatter, kept in place; everything else
 * (markup, styles) blanked to spaces, line breaks kept. Plain JS / TS files
 * (and other formats) are returned unchanged. Used to estimate untested files' coverage totals:
 * template code is not counted.
 */
export function scriptOf(filePath: string, source: string): string {
  if (!SFC_RE.test(filePath)) { return source; }
  const keep: Array<[number, number]> = [];
  if (/\.astro$/i.test(filePath)) {
    const fm = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (fm) {
      const start = source.indexOf(fm[1], fm.index);
      keep.push([start, start + fm[1].length]);
    }
  }
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const start = m.index + m[0].indexOf('>') + 1;
    keep.push([start, start + m[1].length]);
  }
  let out = '';
  let pos = 0;
  const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');
  for (const [a, b] of keep.sort((x, y) => x[0] - y[0])) {
    if (a < pos) { continue; }
    out += blank(source.slice(pos, a)) + source.slice(a, b);
    pos = b;
  }
  return out + blank(source.slice(pos));
}
