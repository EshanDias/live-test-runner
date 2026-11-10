import * as fs from 'fs';
import * as path from 'path';

/**
 * The test files that import `changed`, directly or through other files —
 * by following relative imports (`import … from './x'`, `export … from`,
 * `import('./x')`, `require('./x')`) between the JS / TS files under
 * `folders`. For frameworks without a related run of their own (Angular's
 * builder). Path aliases (tsconfig `paths`) are not followed: `undefined`
 * means the graph could not decide (nothing imports the file through a
 * relative path), and the caller should run everything.
 */
export function testFilesImporting(changed: string, folders: string[], isTestFile: (file: string) => boolean): string[] | undefined {
  const files = folders.flatMap((f) => sourceFilesUnder(f));
  const importers = new Map<string, Set<string>>();
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of relativeSpecifiers(text)) {
      const target = resolveRelative(file, spec);
      if (!target) { continue; }
      const set = importers.get(target) ?? new Set<string>();
      set.add(file);
      importers.set(target, set);
    }
  }
  const start = path.resolve(changed);
  if (isTestFile(start)) { return [start]; }
  if (!importers.has(start)) { return undefined; }
  const seen = new Set<string>([start]);
  const queue = [start];
  const tests = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const imp of importers.get(cur) ?? []) {
      if (seen.has(imp)) { continue; }
      seen.add(imp);
      if (isTestFile(imp)) { tests.add(imp); } else { queue.push(imp); }
    }
  }
  return [...tests];
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.angular', 'out']);

function sourceFilesUnder(dir: string, depth = 0): string[] {
  if (depth > 20) { return []; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { return SKIP.has(e.name) ? [] : sourceFilesUnder(p, depth + 1); }
    return SOURCE.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

const IMPORT_RE = /(?:\bimport\s*(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+(?:type\s+)?[\w*{}\s,$]*\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+|\.{1,2})['"]/g;

/** Relative module specifiers of a file (comments are not stripped: an import in a comment only adds a rerun). */
export function relativeSpecifiers(text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1]);
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** A relative specifier as the file it names (TypeScript's lookup: as is, with an extension, `index`; `.js` written for a `.ts`). */
export function resolveRelative(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [
    base,
    ...EXTS.map((e) => base + e),
    ...(/\.[cm]?js$/.test(base) ? EXTS.map((e) => base.replace(/\.[cm]?js$/, e)) : []),
    ...EXTS.map((e) => path.join(base, `index${e}`)),
  ];
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}
