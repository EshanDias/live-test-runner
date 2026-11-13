/**
 * The static import graph of a Python project — the pytest fallback for
 * "which tests use this file" when covering tests (coverage contexts) do not
 * know it yet (pytest plan 6.2, like `jest --findRelatedTests`):
 *
 *  - `import a.b`, `import a.b as x`, `from a.b import c` (c may be a
 *    submodule), `from . import x`, `from ..pkg import y`;
 *  - module names resolve against the import roots: the project root, `src/`,
 *    pytest's `pythonpath` option, and each test file's own folder (pytest's
 *    default rootdir-less import mode puts it on sys.path);
 *  - dependents are transitive; a saved `conftest.py` is used by every test
 *    file under its folder.
 *
 * Read as text (no Python needed), cached per file by mtime and size.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logicalLines } from './discovery/pythonDiscovery';

interface Parsed { stamp: string; imports: string[] }

const IMPORT_RE = /^import\s+(.+)$/;
const FROM_RE = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/;

/** The modules a file names: absolute dotted names, or relative ones resolved against its package. */
export function importedNames(source: string): { absolute: string[]; relative: { level: number; name: string; members: string[] }[] } {
  const absolute: string[] = [];
  const relative: { level: number; name: string; members: string[] }[] = [];
  for (const { text } of logicalLines(source)) {
    const body = text.trim();
    const imp = IMPORT_RE.exec(body);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_][\w.]*$/.test(name)) { absolute.push(name); }
      }
      continue;
    }
    const from = FROM_RE.exec(body);
    if (from) {
      const [, dots, mod, rest] = from;
      const members = rest.replace(/[()]/g, ' ').split(',').map((m) => m.trim().split(/\s+as\s+/)[0].trim()).filter((m) => /^[A-Za-z_]\w*$/.test(m));
      if (dots.length > 0) {
        relative.push({ level: dots.length, name: mod, members });
      } else if (mod) {
        absolute.push(mod);
        for (const m of members) { absolute.push(`${mod}.${m}`); }
      }
    }
  }
  return { absolute, relative };
}

export class PythonImportGraph {
  private readonly _parsed = new Map<string, Parsed>();

  /**
   * @param _roots import roots (absolute), in sys.path order
   */
  constructor(private readonly _roots: string[]) {}

  /** The project files `filePath` imports directly (resolved, existing). */
  importsOf(filePath: string): string[] {
    let stamp: string;
    try {
      const st = fs.statSync(filePath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return [];
    }
    const cached = this._parsed.get(filePath);
    if (cached && cached.stamp === stamp) { return cached.imports; }
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf8'); } catch { /* unreadable */ }
    const { absolute, relative } = importedNames(source);
    const found = new Set<string>();
    const roots = [path.dirname(filePath), ...this._roots];
    for (const name of absolute) {
      for (const f of this._resolveDotted(name, roots)) { found.add(f); }
    }
    for (const r of relative) {
      let base = path.dirname(filePath);
      for (let i = 1; i < r.level; i++) { base = path.dirname(base); }
      const modDir = r.name ? path.join(base, ...r.name.split('.')) : base;
      for (const f of moduleFiles(modDir)) { found.add(f); }
      for (const m of r.members) { for (const f of moduleFiles(path.join(modDir, m))) { found.add(f); } }
    }
    found.delete(filePath);
    const imports = [...found];
    this._parsed.set(filePath, { stamp, imports });
    return imports;
  }

  /**
   * The test files that import `sourceFile` directly or through other
   * project modules. A conftest.py is used by every test file under its folder.
   */
  dependents(sourceFile: string, testFiles: string[]): string[] {
    return this.dependentsOf([sourceFile], testFiles).get(path.normalize(sourceFile)) ?? [];
  }

  /**
   * {@link dependents} of several source files at once (keys: normalised
   * paths). Each test file's imports are walked once and each file's imports
   * read once per call: asking per source file walked every test file's
   * imports again, with a stat per step (millions of calls per batch on a
   * large project, all on the extension host).
   */
  dependentsOf(sourceFiles: string[], testFiles: string[]): Map<string, string[]> {
    const imports = new Map<string, string[]>();
    const importsOf = (f: string) => {
      let list = imports.get(f);
      if (!list) { list = this.importsOf(f).map((d) => path.normalize(d)); imports.set(f, list); }
      return list;
    };
    const targets = new Set(sourceFiles.map((f) => path.normalize(f)));
    const out = new Map<string, string[]>([...targets].map((t) => [t, []]));
    const plain = [...targets].filter((t) => path.basename(t) !== 'conftest.py');
    for (const t of targets) {
      if (path.basename(t) !== 'conftest.py') { continue; }
      const dir = path.dirname(t);
      out.set(t, testFiles.filter((f) => f.startsWith(dir + path.sep)));
    }
    if (plain.length === 0) { return out; }
    for (const test of testFiles) {
      const from = path.normalize(test);
      const seen = new Set<string>([from]);
      const queue = [from];
      for (let i = 0; i < queue.length; i++) {
        for (const dep of importsOf(queue[i])) {
          if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
        }
      }
      for (const t of plain) {
        if (t !== from && seen.has(t)) { out.get(t)!.push(test); }
      }
    }
    return out;
  }

  /** `a.b.c` → the files that importing it runs: each package's __init__.py on the way and the module itself. */
  private _resolveDotted(name: string, roots: string[]): string[] {
    const parts = name.split('.');
    for (const root of roots) {
      const first = path.join(root, parts[0]);
      if (!moduleFiles(first).length) { continue; }
      const out: string[] = [];
      for (let i = 1; i <= parts.length; i++) {
        const files = moduleFiles(path.join(root, ...parts.slice(0, i)));
        if (files.length === 0) { break; }
        out.push(...files);
      }
      return out;
    }
    return [];
  }
}

/** A module path without extension → its file (`x.py`) or package (`x/__init__.py`). */
function moduleFiles(base: string): string[] {
  const out: string[] = [];
  for (const f of [`${base}.py`, path.join(base, '__init__.py')]) {
    try { if (fs.statSync(f).isFile()) { out.push(f); } } catch { /* none */ }
  }
  return out;
}

/** The import roots of a pytest project: its root, `src/`, and pytest's `pythonpath` option. */
export function pythonImportRoots(projectRoot: string, pythonpath: string[] = []): string[] {
  const roots = [projectRoot, path.join(projectRoot, 'src'), ...pythonpath.map((p) => path.resolve(projectRoot, p))];
  return [...new Set(roots)].filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}
