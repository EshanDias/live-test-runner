/**
 * Which files are a project's source code, whatever UI framework it uses.
 *
 * JS / TS plus the single-file component formats test frameworks load
 * through their own transforms (Vite plugins, Jest transformers): Vue,
 * Svelte, Astro, Marko. The same list Vitest uses by default for coverage
 * (`coverage.extension`). React, Solid, Preact, Lit, Angular and Qwik code
 * is plain .js / .jsx / .ts / .tsx.
 *
 * Saving such a file reruns the tests that use it; the execution trace and
 * coverage reach it when the test framework can load it.
 */

/** Extensions (without the dot) of JS / TS sources. */
export const SCRIPT_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'] as const;

/** Extensions (without the dot) of single-file components. */
export const COMPONENT_EXTENSIONS = ['vue', 'svelte', 'astro', 'marko'] as const;

export const SOURCE_EXTENSIONS: readonly string[] = [...SCRIPT_EXTENSIONS, ...COMPONENT_EXTENSIONS];

const SOURCE_RE = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');
const COMPONENT_RE = new RegExp(`\\.(?:${COMPONENT_EXTENSIONS.join('|')})$`, 'i');

/** A JS / TS file or a component (`.vue`, `.svelte`, …). Type declarations (`.d.ts`) included. */
export function isSourceFile(filePath: string): boolean {
  return SOURCE_RE.test(filePath);
}

/** A single-file component (`.vue`, `.svelte`, `.astro`, `.marko`). */
export function isComponentFile(filePath: string): boolean {
  return COMPONENT_RE.test(filePath);
}

/** VS Code glob for every source file, e.g. `**\/*.{js,…,vue,svelte}`. */
export function sourceFileGlob(): string {
  return `**/*.{${SOURCE_EXTENSIONS.join(',')}}`;
}

/**
 * The script of a component as one JS / TS text with the component's own
 * line numbers: every `<script>` block (Vue, Svelte, Astro, Marko's
 * `<script>`), and Astro's `---` frontmatter, kept in place; everything else
 * (markup, styles) blanked to spaces, line breaks kept. Plain JS / TS files
 * are returned unchanged. Used to estimate untested files' coverage totals:
 * template code is not counted.
 */
export function scriptOf(filePath: string, source: string): string {
  if (!isComponentFile(filePath)) { return source; }
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
