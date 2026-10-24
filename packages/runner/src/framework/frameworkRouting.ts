/**
 * Mixed-framework projects (phase 8): which framework runs each test file.
 *
 * Principle: a test file's framework decides its binary, config, flags,
 * runner, reporter and coverage. Pure logic (file system reads only) — the
 * extension's FrameworkRouter feeds it the listings and the setting.
 *
 * Resolution order for one test file (ADR-8):
 *  1. `liveTestRunner.frameworks` — the first glob that matches wins (explicit).
 *  2. A single-framework project — its framework (every pure Jest / Vitest
 *     project, and every package of a monorepo: phase 7 makes each its own project).
 *  3. Ownership — the framework whose own list (`jest --listTests`,
 *     `vitest list --filesOnly`) contains the file.
 *  4. Both list it — what the file uses: an import from `vitest` / a `vi.` call
 *     → Vitest; `@jest/globals` / a `jest.` call → Jest; nothing (or both)
 *     → the project's primary framework, with one WARN naming the setting (D13).
 */
import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORK_IDS, FrameworkId } from '../types';
import { JEST_CONFIG_FILES, JestAdapter, readPackageJson } from './adapters/JestAdapter';
import { CRAAdapter } from './adapters/CRAAdapter';
import { VITEST_CONFIG_FILES } from './adapters/VitestAdapter';
import type { RoutedFramework } from './allowedFrameworks';
export { allowFrameworkAt, isFrameworkAllowedAt } from './allowedFrameworks';
export type { RoutedFramework };


const CONFIG_EXTS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'];
const VITEST_WORKSPACE_FILES = CONFIG_EXTS.map((e) => `vitest.workspace.${e}`);

/** What a project root runs with. */
export interface ProjectFrameworks {
  /** What detection picks for the root today (`jest` for Jest and CRA projects). */
  primary: RoutedFramework;
  /** Both frameworks are configured in this root. */
  mixed: boolean;
  /** One line for logs. */
  reason: string;
}

/**
 * Whether a root is a mixed Jest + Vitest project. Conservative (ADR-8 §1):
 * a Jest marker (a `jest` dependency, a `jest.config.*`, `package.json#jest`
 * or Create React App) **and** a Vitest config file of the root's own
 * (`vitest.config.*` / `vitest.workspace.*`). A `vitest` dependency alone is
 * not enough (jest-dom lists Vitest but runs on Jest), nor is a
 * `vite.config.*` (many Jest projects build with Vite).
 *
 * @param detected the framework detection picked for the root (FrameworkDetector)
 */
export function projectFrameworks(root: string, detected: FrameworkId): ProjectFrameworks {
  const primary: RoutedFramework = detected === FRAMEWORK_IDS.vitest ? 'vitest' : 'jest';
  if (primary === 'vitest') {
    // Vitest is picked only when nothing marks the root as Jest (BUG-37 rule) — never mixed by detection.
    return { primary, mixed: false, reason: 'a Vitest project' };
  }
  const jestMarker = hasJestMarker(root);
  const vitestConfig = [...VITEST_CONFIG_FILES, ...VITEST_WORKSPACE_FILES].find((f) => exists(path.join(root, f)));
  if (jestMarker && vitestConfig) {
    return { primary, mixed: true, reason: `${jestMarker} and ${vitestConfig}` };
  }
  return { primary, mixed: false, reason: jestMarker ? `${jestMarker}, no Vitest config` : 'no Vitest config' };
}

/** What marks a root as Jest (for the log line), or undefined. */
function hasJestMarker(root: string): string | undefined {
  const config = JEST_CONFIG_FILES.find((f) => exists(path.join(root, f)));
  if (config) { return config; }
  const pkg = readPackageJson(root);
  if (pkg?.jest !== undefined) { return 'package.json#jest'; }
  try { if (new CRAAdapter().detect(root)) { return 'react-scripts'; } } catch { /* not CRA */ }
  if (new JestAdapter().detect(root)) { return 'a jest dependency'; }
  return undefined;
}

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

// ── Hints in the file ──────────────────────────────────────────────────────────

const VITEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](?:vitest|vitest\/[\w/-]+|@vitest\/[\w/-]+)['"]/;
const JEST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]@jest\/globals['"]/;
const VI_CALL = /(?<![\w$.])vi\s*\.\s*[A-Za-z_$]/;
const JEST_CALL = /(?<![\w$.])jest\s*\.\s*[A-Za-z_$]/;

/** Source without comments, so a `// jest.fn() is not used here` line is no hint. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

/**
 * The framework a test file says it uses (rule 4), or undefined when it says
 * nothing or both: an import from `vitest` (or `@vitest/*`) → Vitest, from
 * `@jest/globals` → Jest; else a `vi.` call → Vitest, a `jest.` call → Jest.
 * Imports decide before calls.
 */
export function frameworkHint(source: string): RoutedFramework | undefined {
  const src = stripComments(source);
  const vImport = VITEST_IMPORT.test(src);
  const jImport = JEST_IMPORT.test(src);
  if (vImport !== jImport) { return vImport ? 'vitest' : 'jest'; }
  if (vImport && jImport) { return undefined; }
  const vCall = VI_CALL.test(src);
  const jCall = JEST_CALL.test(src);
  if (vCall !== jCall) { return vCall ? 'vitest' : 'jest'; }
  return undefined;
}

// ── The liveTestRunner.frameworks setting ──────────────────────────────────────

/** One entry of `liveTestRunner.frameworks`, resolved. */
export interface FrameworkRule {
  /** The glob as written (for logs). */
  glob: string;
  /** Matches an absolute file path. */
  matches: (filePath: string) => boolean;
  framework: RoutedFramework;
}

/**
 * `**` (any folders), `*` (anything but a separator), `?` (one character),
 * `{a,b}` (alternatives), `[abc]` (a class) — as a RegExp over a path with
 * forward slashes. A glob without a `/` matches a file name anywhere
 * (`*.vitest.ts` = `**\/*.vitest.ts`), as VS Code's file globs do.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) { g = `**/${g}`; }
  let re = '';
  let inBraces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` = zero or more folders; a trailing `**` = anything.
        if (g[i + 2] === '/') { re += '(?:[^/]*/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBraces++; re += '(?:';
    } else if (c === '}' && inBraces > 0) {
      inBraces--; re += ')';
    } else if (c === ',' && inBraces > 0) {
      re += '|';
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i) { re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; } else { re += '\\['; }
    } else {
      re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** What the setting may hold per glob. */
export type FrameworkRuleSetting = string | { framework?: unknown; [other: string]: unknown };

/**
 * Parses `liveTestRunner.frameworks` (glob → `"jest"` / `"vitest"`, or
 * `{ "framework": … }`). Globs are relative to `baseDir` (the workspace
 * folder) unless absolute. Each file runs with its framework's own config
 * from the project root — other keys (a per-glob `config` / `root`) are not
 * supported and reported. Invalid entries are returned in `errors` (one line
 * each) and skipped.
 */
export function parseFrameworkRules(
  setting: unknown,
  baseDir: string,
): { rules: FrameworkRule[]; errors: string[] } {
  const rules: FrameworkRule[] = [];
  const errors: string[] = [];
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    if (setting !== undefined && setting !== null) { errors.push('liveTestRunner.frameworks must be an object: { "<glob>": "jest" | "vitest" }'); }
    return { rules, errors };
  }
  const base = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const [glob, raw] of Object.entries(setting as Record<string, FrameworkRuleSetting>)) {
    const value = typeof raw === 'string' ? { framework: raw } : raw;
    const framework = typeof value?.framework === 'string' ? value.framework.trim().toLowerCase() : '';
    if (framework !== 'jest' && framework !== 'vitest') {
      errors.push(`liveTestRunner.frameworks["${glob}"]: framework must be "jest" or "vitest" (got ${JSON.stringify(value?.framework)}) — entry ignored`);
      continue;
    }
    const extra = typeof raw === 'object' && raw ? Object.keys(raw).filter((k) => k !== 'framework') : [];
    if (extra.length > 0) {
      errors.push(`liveTestRunner.frameworks["${glob}"]: ${extra.map((k) => `"${k}"`).join(', ')} not supported — the files run with the ${framework} config of their project root`);
    }
    const g = glob.replace(/\\/g, '/');
    const absoluteGlob = path.isAbsolute(glob) || /^[a-zA-Z]:\//.test(g);
    const re = globToRegExp(g);
    const matches = (filePath: string) => {
      const f = filePath.replace(/\\/g, '/');
      if (absoluteGlob) { return re.test(f); }
      const prefix = `${base}/`;
      const inside = process.platform === 'win32' ? f.toLowerCase().startsWith(prefix.toLowerCase()) : f.startsWith(prefix);
      return inside && re.test(f.slice(prefix.length));
    };
    rules.push({ glob, matches, framework });
  }
  return { rules, errors };
}

/** The first rule that matches a file (the setting's declaration order). */
export function matchFrameworkRule(rules: readonly FrameworkRule[], filePath: string): FrameworkRule | undefined {
  return rules.find((r) => r.matches(filePath));
}

// ── Assigning files to frameworks ──────────────────────────────────────────────

/** Why a file got its framework. */
export type AssignmentRule = 'setting' | 'project' | 'ownership' | 'hint' | 'primary';

export interface FrameworkAssignment {
  /** The group (framework bundle) that runs the file. */
  group: string;
  rule: AssignmentRule;
  /** The group lists the file (or its list is unknown) — the file can run. */
  runnable: boolean;
}

export interface AssignInput {
  /** Every test file to place: discovered ∪ listed. */
  files: string[];
  /** Comparable spelling of a path (case-folded on Windows, editor spelling). */
  keyOf: (filePath: string) => string;
  /**
   * The groups that own files by their framework's config (rule 3), each with
   * its list (undefined = listing failed: it may own any file). The primary
   * group first. One group = a single-framework project (rule 2).
   */
  groups: { id: string; framework: RoutedFramework; files: string[] | undefined }[];
  /** The primary group's id. */
  primary: string;
  /** Rule 1: the group a setting entry sends the file to. */
  ruleFor?: (filePath: string) => string | undefined;
  /** Rule 4: what the file says it uses (read lazily, only for conflicts). */
  hint?: (filePath: string) => RoutedFramework | undefined;
}

export interface AssignOutput {
  /** File key → its assignment. */
  assignments: Map<string, FrameworkAssignment>;
  /** Files both frameworks list with no hint — they ran with the primary framework (D13). */
  defaulted: string[];
  /** Files listed by both and settled by a hint (for a DEBUG line). */
  hinted: string[];
}

/**
 * Places every file in exactly one group (pure). See the module comment for
 * the order; a file no group lists stays with the primary group, not runnable
 * (it shows as excluded, as before phase 8).
 */
export function assignFrameworks(input: AssignInput): AssignOutput {
  const { files, keyOf, groups, primary } = input;
  const listed = new Map<string, Set<string> | undefined>();
  for (const g of groups) { listed.set(g.id, g.files ? new Set(g.files.map(keyOf)) : undefined); }
  const lists = (id: string, key: string) => { const s = listed.get(id); return s === undefined ? undefined : s.has(key); };
  const canRun = (id: string, key: string) => lists(id, key) !== false;

  const assignments = new Map<string, FrameworkAssignment>();
  const defaulted: string[] = [];
  const hinted: string[] = [];
  for (const file of files) {
    const key = keyOf(file);
    if (assignments.has(key)) { continue; }
    const fromRule = input.ruleFor?.(file);
    if (fromRule) {
      assignments.set(key, { group: fromRule, rule: 'setting', runnable: canRun(fromRule, key) });
      continue;
    }
    if (groups.length <= 1) {
      const only = groups[0]?.id ?? primary;
      assignments.set(key, { group: only, rule: 'project', runnable: canRun(only, key) });
      continue;
    }
    const known = groups.filter((g) => lists(g.id, key) === true);
    const candidates = groups.filter((g) => lists(g.id, key) !== false);
    if (candidates.length === 0) {
      assignments.set(key, { group: primary, rule: 'ownership', runnable: false });
      continue;
    }
    if (candidates.length === 1) {
      assignments.set(key, { group: candidates[0].id, rule: 'ownership', runnable: true });
      continue;
    }
    const hint = input.hint?.(file);
    const byHint = hint ? candidates.find((g) => g.framework === hint) : undefined;
    // Only one list is known to hold it (the other listing failed): that one, unless the file says otherwise.
    if (!byHint && known.length === 1) {
      assignments.set(key, { group: known[0].id, rule: 'ownership', runnable: true });
      continue;
    }
    if (byHint) {
      if (known.length >= 2) { hinted.push(file); }
      assignments.set(key, { group: byHint.id, rule: 'hint', runnable: true });
      continue;
    }
    const fallback = candidates.find((g) => g.id === primary) ?? candidates[0];
    if (known.length >= 2) { defaulted.push(file); }
    assignments.set(key, { group: fallback.id, rule: 'primary', runnable: true });
  }
  return { assignments, defaulted, hinted };
}
