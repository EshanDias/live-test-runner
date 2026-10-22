import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORK_IDS, FrameworkId } from '../types';
import { FrameworkRegistry } from './FrameworkRegistry';
import { JEST_CONFIG_FILES, readPackageJson } from './adapters/JestAdapter';
import { VITEST_CONFIG_FILES, VITE_CONFIG_FILES } from './adapters/VitestAdapter';
import { createLogger } from '../utils/logger';

const log = createLogger('Projects');

/**
 * One test project in the workspace — a folder that is run as a whole, from
 * its own root, with its own framework and config (phase 7, D11/D12).
 */
export interface DetectedProject {
  /** Absolute folder the framework runs from. */
  root: string;
  /** package.json `name`, else the folder name. Unique within one detection. */
  name: string;
  /** The framework the registry detects there (`unknown`: none matched — run as plain Jest). */
  framework: FrameworkId;
  /** Why this folder is a project, for the log. */
  reason: string;
}

/** Folders never searched for workspace packages. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out']);
/** `**` in a workspace glob descends at most this far. */
const MAX_GLOB_DEPTH = 6;

const VITEST_WORKSPACE_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map((e) => `vitest.workspace.${e}`);

/**
 * True when the folder itself configures a test framework: a Jest config
 * file or `package.json#jest`, a Vitest / Vite config or workspace file, or
 * a Create React App test script. A monorepo root with such a config runs
 * its packages itself (Jest `projects`, Vitest `test.projects`, or one
 * config for everything) — it is one project, never split per package.
 */
export function hasOwnTestConfig(dir: string): boolean {
  const pkg = readPackageJson(dir);
  if (pkg?.jest !== undefined) { return true; }
  if (/react-scripts\s+test/.test(String(pkg?.scripts?.test ?? ''))) { return true; }
  return [...JEST_CONFIG_FILES, ...VITEST_CONFIG_FILES, ...VITE_CONFIG_FILES, ...VITEST_WORKSPACE_FILES]
    .some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * The framework a folder's tests run with, or undefined when nothing marks it
 * as a test project: a registered adapter's `detect()` (dependency or
 * config), or a `test` script that runs jest / vitest / react-scripts with
 * the framework installed higher up (hoisted in the workspace root).
 */
export function testFrameworkOf(dir: string, registry: FrameworkRegistry = FrameworkRegistry.default()): FrameworkId | undefined {
  for (const adapter of registry.adapters()) {
    try {
      if (adapter.detect(dir)) { return adapter.framework; }
    } catch { /* an adapter that cannot read the folder does not claim it */ }
  }
  const script = String(readPackageJson(dir)?.scripts?.test ?? '');
  if (/\breact-scripts\s+test\b/.test(script)) { return FRAMEWORK_IDS.cra; }
  if (/\bvitest\b/.test(script)) { return FRAMEWORK_IDS.vitest; }
  if (/\bjest\b/.test(script)) { return FRAMEWORK_IDS.jest; }
  return undefined;
}

/**
 * Workspace package globs of a monorepo root: `pnpm-workspace.yaml`
 * `packages:` and `package.json#workspaces` (npm / yarn / bun; an array or
 * `{ packages: [...] }`). Negated globs (`!…`) are returned with their `!`.
 */
export function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  const pkg = readPackageJson(root);
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  for (const g of list) { if (typeof g === 'string' && g.trim()) { globs.push(g.trim()); } }
  try {
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    globs.push(...pnpmWorkspacePackages(yaml));
  } catch { /* no pnpm workspace */ }
  return [...new Set(globs)];
}

/**
 * The `packages:` list of a pnpm-workspace.yaml — block (`- 'packages/*'`) or
 * flow (`packages: [a, b]`) style. Only this key is read, so no YAML parser.
 */
export function pnpmWorkspacePackages(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) { continue; }
    const rest = m[1].replace(/\s+#.*$/, '').trim();
    if (rest.startsWith('[')) {
      return rest.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
    }
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*(#.*)?$/.test(line)) { continue; }
      const item = /^\s+-\s+(.+?)\s*(#.*)?$/.exec(line);
      if (!item) { break; } // the next top-level key
      out.push(unquote(item[1]));
    }
    return out.filter(Boolean);
  }
  return [];
}

/**
 * Folders (with a package.json) matched by workspace globs, relative to
 * `root`: `*` is one path segment (also inside a name: `pkg-*`), `**` any
 * depth. node_modules, dot folders and build output are never entered.
 */
export function expandWorkspaceGlobs(root: string, globs: string[]): string[] {
  const expand = (list: string[]) => {
    const found = new Set<string>();
    for (const glob of list) {
      const segments = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
      walk(root, segments, 0, found);
    }
    return found;
  };
  const included = expand(globs.filter((g) => !g.startsWith('!')));
  const excluded = [...expand(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)))];
  return [...included]
    .filter((dir) => !excluded.some((x) => samePath(x, dir) || isInside(dir, x)))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .sort();
}

function walk(dir: string, segments: string[], depth: number, out: Set<string>): void {
  if (segments.length === 0) { out.add(dir); return; }
  const [seg, ...rest] = segments;
  if (seg === '**') {
    walk(dir, rest, depth, out); // zero segments
    if (depth >= MAX_GLOB_DEPTH) { return; }
    for (const child of subdirs(dir)) { walk(child, segments, depth + 1, out); }
    return;
  }
  if (!/[*?]/.test(seg)) {
    const next = path.join(dir, seg);
    if (isDir(next)) { walk(next, rest, depth + 1, out); }
    return;
  }
  const re = segmentRegExp(seg);
  for (const child of subdirs(dir)) {
    if (re.test(path.basename(child))) { walk(child, rest, depth + 1, out); }
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function segmentRegExp(seg: string): RegExp {
  return new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

/**
 * The test projects of one workspace folder:
 *  1. The folder configures a framework itself (see {@link hasOwnTestConfig})
 *     → one project, the folder — its config already covers its packages
 *     (the `jest` repo's root `projects`, vueuse's / slidev's `test.projects`).
 *  2. It is a monorepo root (pnpm-workspace.yaml / package.json#workspaces)
 *     without a test config of its own → one project per workspace package
 *     that has tests (a framework dependency, config or test script).
 *  3. Otherwise the folder, if a framework is detected there.
 */
export function projectsInFolder(folder: string, registry: FrameworkRegistry = FrameworkRegistry.default()): DetectedProject[] {
  const own = testFrameworkOf(folder, registry);
  const single = (reason: string): DetectedProject[] =>
    own ? [{ root: folder, name: projectName(folder), framework: own, reason }] : [];

  if (hasOwnTestConfig(folder)) {
    return single('the folder has its own test config');
  }
  const globs = workspaceGlobs(folder);
  if (globs.length === 0) {
    return single(`${own ?? 'a test framework'} detected in the folder`);
  }
  const packages: DetectedProject[] = [];
  for (const dir of expandWorkspaceGlobs(folder, globs)) {
    if (path.resolve(dir) === path.resolve(folder)) { continue; }
    const framework = testFrameworkOf(dir, registry);
    if (framework) {
      packages.push({ root: dir, name: projectName(dir), framework, reason: `workspace package (${framework})` });
    }
  }
  if (packages.length === 0) {
    return single('a monorepo root whose packages have no tests of their own');
  }
  return packages;
}

/**
 * Every test project in the workspace folders, each folder handled by
 * {@link projectsInFolder}. A project inside another project's folder is
 * dropped (the outer one runs it — VS Code workspaces may list a package as
 * a folder of its own). With one folder and nothing detected, that folder is
 * returned anyway (framework `unknown`, run as plain Jest — as before
 * multi-project support). Names are made unique with their relative path.
 */
export function findTestProjects(folders: string[], registry: FrameworkRegistry = FrameworkRegistry.default()): DetectedProject[] {
  const all: DetectedProject[] = [];
  for (const folder of folders) {
    for (const p of projectsInFolder(folder, registry)) {
      if (!all.some((q) => samePath(q.root, p.root))) { all.push(p); }
    }
  }
  const kept = all.filter((p) => !all.some((q) => q !== p && isInside(p.root, q.root)));
  if (kept.length === 0 && folders.length === 1) {
    kept.push({ root: folders[0], name: projectName(folders[0]), framework: FRAMEWORK_IDS.unknown, reason: 'the only folder (no test framework recognised)' });
  }
  uniqueNames(kept, folders);
  for (const p of kept) { log.debug(`Project "${p.name}" (${p.framework}) at ${p.root} — ${p.reason}`); }
  return kept;
}

function projectName(dir: string): string {
  const name = readPackageJson(dir)?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : path.basename(dir);
}

function uniqueNames(projects: DetectedProject[], folders: string[]): void {
  const counts = new Map<string, number>();
  for (const p of projects) { counts.set(p.name, (counts.get(p.name) ?? 0) + 1); }
  for (const p of projects) {
    if ((counts.get(p.name) ?? 0) < 2) { continue; }
    const base = folders.find((f) => isInside(p.root, f) || samePath(p.root, f));
    const rel = base ? path.relative(path.dirname(base), p.root).split(path.sep).join('/') : p.root;
    p.name = `${p.name} (${rel})`;
  }
}

function comparable(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** `inner` is strictly inside `outer`. */
export function isInside(inner: string, outer: string): boolean {
  const rel = path.relative(comparable(outer), comparable(inner));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
