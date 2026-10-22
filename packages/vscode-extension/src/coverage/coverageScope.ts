/**
 * CoverageScope — which files count toward the coverage totals, read from the
 * project's own coverage settings so the totals match the framework's CLI
 * report (`vitest run --coverage`, `jest --coverage`).
 *
 * Built per framework from its resolved config; when the config cannot be
 * read, {@link defaultCoverageScope} applies the built-in rules.
 */
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { isExcludedFromCoverage } from './coverageRules';

export interface CoverageScope {
  /** Where the rules come from, for the log ("Vitest coverage.include / exclude"). */
  readonly source: string;
  /**
   * Whether files no test loaded count too (at 0%). True only when the config
   * lists the files to cover (Vitest `coverage.include`, Jest `collectCoverageFrom`);
   * otherwise the CLI reports only the files the tests loaded.
   */
  readonly includesUntouched: boolean;
  /** True when the default rules apply (config unreadable): the scan also skips git-ignored files. */
  readonly isDefault: boolean;
  /** Whether a file (absolute path) counts toward coverage. */
  counts(filePath: string): boolean;
}

/** The built-in rules: every source file outside tests, configs, build output and dependencies. */
export function defaultCoverageScope(projectRoot: string): CoverageScope {
  return {
    source: 'built-in rules',
    includesUntouched: true,
    isDefault: true,
    counts: (fp) => !isExcludedFromCoverage(path.relative(projectRoot, fp)),
  };
}

/** The project's scope from its config, else the built-in rules. */
export async function coverageScopeOf(
  config: { coverageScope(projectRoot: string): Promise<CoverageScope | undefined> },
  projectRoot: string,
): Promise<CoverageScope> {
  try {
    return (await config.coverageScope(projectRoot)) ?? defaultCoverageScope(projectRoot);
  } catch {
    return defaultCoverageScope(projectRoot);
  }
}

/** The coverage options of a resolved Vitest config. */
export interface VitestCoverageSettings {
  /** The config's `root` — the globs are relative to it. */
  root: string;
  include?: string[];
  /** With Vitest's defaults (test files, configs, node_modules) already merged in. */
  exclude?: string[];
  /** Vitest < 4 only: count files no test loaded. Undefined from Vitest 4 (`include` decides). */
  all?: boolean;
}

export function vitestCoverageScope(s: VitestCoverageSettings): CoverageScope {
  const include = s.include ?? [];
  const isIncluded = include.length > 0 ? globMatcher(include) : () => true;
  const isExcluded = globMatcher(s.exclude ?? [], false);
  return {
    source: 'Vitest coverage.include / exclude',
    // Vitest < 4: `all` (default true) counts untouched files even without an include list.
    // Vitest 4+: no `all` — only an include list does.
    includesUntouched: include.length > 0 ? s.all !== false : s.all === true,
    isDefault: false,
    counts: (fp) => {
      const rel = relativePosix(s.root, fp);
      if (rel === undefined || /(^|\/)node_modules\//.test(rel)) { return false; }
      return isIncluded(rel) && !isExcluded(rel);
    },
  };
}

/** The coverage options of a resolved Jest config (`jest --showConfig`). */
export interface JestCoverageSettings {
  /** Global `rootDir` — `collectCoverageFrom` is relative to it. */
  rootDir: string;
  collectCoverageFrom?: string[];
  /** Regexes tested against the absolute path (every project's, merged). */
  coveragePathIgnorePatterns?: string[];
  /** Test-file rules (every project's): test files never count. */
  testMatch?: string[];
  testRegex?: string[];
  /** Absolute paths of setup files (setupFiles, setupFilesAfterEnv, globalSetup / Teardown). */
  setupFiles?: string[];
}

/** The rules Jest's own `shouldInstrument` applies. */
export function jestCoverageScope(s: JestCoverageSettings): CoverageScope {
  const collectFrom = s.collectCoverageFrom ?? [];
  const isCollected = collectFrom.length > 0 ? globMatcher(collectFrom) : () => true;
  const isTestByGlob = globMatcher(s.testMatch ?? [], false);
  const testRegex = compileRegexes(s.testRegex);
  const ignore = compileRegexes(s.coveragePathIgnorePatterns ?? ['/node_modules/']);
  const setupFiles = new Set((s.setupFiles ?? []).map(pathKey));
  return {
    source: collectFrom.length > 0 ? 'Jest collectCoverageFrom / coveragePathIgnorePatterns' : 'Jest coveragePathIgnorePatterns',
    includesUntouched: collectFrom.length > 0,
    isDefault: false,
    counts: (fp) => {
      const posix = fp.replace(/\\/g, '/');
      // Jest's spelling has an upper-case drive and symlinks resolved; VS Code's neither.
      const real = realpath(fp);
      const spellings = [...new Set([fp, fp.replace(/^[a-z]:/, (d) => d.toUpperCase()), posix, real, real.replace(/\\/g, '/')])];
      if (/\/node_modules\//.test(posix) || /\/__mocks__\//.test(posix)) { return false; }
      if (spellings.some((p) => isTestByGlob(p.replace(/\\/g, '/'))) || spellings.some((p) => testRegex.some((re) => re.test(p)))) { return false; }
      if (setupFiles.has(pathKey(fp)) || setupFiles.has(pathKey(real))) { return false; }
      const rel = relativePosix(s.rootDir, fp);
      if (collectFrom.length > 0 && (rel === undefined || !isCollected(rel))) { return false; }
      return !spellings.some((p) => ignore.some((re) => re.test(p)));
    },
  };
}

/**
 * micromatch-style list matching (what Jest and Vitest use): a path matches
 * when it matches a positive pattern and no `!negated` one. A list of only
 * negations matches everything they do not exclude.
 */
function globMatcher(patterns: string[], emptyMatchesAll = true): (p: string) => boolean {
  // Vite's virtual-module markers ('**/\0*') never match a file on disk, but picomatch
  // matches them against every path — drop patterns with control characters.
  patterns = patterns.filter((p) => ![...p].some((c) => c.charCodeAt(0) < 0x20));
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (positive.length === 0 && negative.length === 0) { return () => emptyMatchesAll; }
  const pos = positive.length > 0 ? picomatch(positive, { dot: true }) : () => true;
  const neg = negative.length > 0 ? picomatch(negative, { dot: true }) : () => false;
  return (p) => pos(p) && !neg(p);
}

function compileRegexes(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    try { out.push(new RegExp(p)); } catch { /* not a valid regex — Jest would have rejected the config */ }
  }
  return out;
}

/**
 * `file` relative to `root` with forward slashes; undefined when outside it.
 * The framework's root is often the real path (macOS `/private/var/…`, Windows
 * upper-case drive / long names) while the editor's file path is not, so the
 * real paths are compared too.
 */
function relativePosix(root: string, file: string): string | undefined {
  const inside = (r: string, f: string) => {
    const rel = path.relative(r, f);
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.replace(/\\/g, '/');
  };
  return inside(root, file)
    ?? (process.platform === 'win32' ? inside(root.toLowerCase(), file.toLowerCase()) : undefined)
    ?? inside(realpath(root), realpath(file));
}

function realpath(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
