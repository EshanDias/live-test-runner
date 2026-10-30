/**
 * Coverage rules shared by every framework's batch runner, so a file counts
 * the same way whichever framework measured it.
 */
import * as fs from 'fs';
import { CoverageEntry, FileCov, LiveCov, Manifest } from './types';

/** Files that never count toward coverage (tests, configs, build output, dependencies). */
const COVERAGE_EXCLUDE_RE = [
  /[/\\]node_modules[/\\]/,
  /\.(test|spec)\.(js|ts|jsx|tsx)$/,
  // pytest's default python_files, and its fixture files
  /(^|[/\\])(test_[^/\\]*|[^/\\]*_test|conftest)\.py$/,
  /[/\\](__tests__|__mocks__|tests?|specs?)[/\\]/,
  /\.config\.(js|ts|mjs|cjs)$/,
  /\.d\.ts$/,
  /[/\\](dist|build|out|\.next|coverage)[/\\]/,
  // Python environments and caches
  /[/\\](site-packages|\.venv|venv|\.tox|\.nox|__pycache__)[/\\]/,
];

/** True for a project-relative path that never counts toward coverage. */
export function isExcludedFromCoverage(filePath: string): boolean {
  // A leading separator so top-level folders (`test/…`, `dist/…`) match the folder rules too.
  const p = /^[/\\]/.test(filePath) ? filePath : `/${filePath}`;
  return COVERAGE_EXCLUDE_RE.some((re) => re.test(p));
}

/** Two counter snapshots of the same file version merged: the higher count wins (runs accumulate). */
export function mergeCounters(a: LiveCov, b: FileCov): LiveCov {
  return {
    s: Object.fromEntries(
      Object.keys({ ...a.s, ...b.s }).map((id) => [id, Math.max(a.s[id] ?? 0, b.s[id] ?? 0)]),
    ),
    b: Object.fromEntries(
      Object.keys({ ...a.b, ...b.b }).map((id) => [
        id,
        (a.b[id] ?? []).map((v, i) => Math.max(v, (b.b[id] as number[] | undefined)?.[i] ?? 0)),
      ]),
    ),
    f: Object.fromEntries(
      Object.keys({ ...a.f, ...b.f }).map((id) => [id, Math.max(a.f[id] ?? 0, b.f[id] ?? 0)]),
    ),
  };
}

/** Which framework wrote a manifest: Vitest's live in `vitest-manifests`, Jest's in `ltr-manifests`. */
function manifestSource(manifestPath: string): 'vitest' | 'jest' {
  return /[/\\]vitest-manifests[/\\]/.test(manifestPath) ? 'vitest' : 'jest';
}

function readManifest(manifestPath: string): Manifest | undefined {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest; } catch { return undefined; }
}

/**
 * New counters for a file merged with what the store already has for it:
 *  - same manifest (same file version, same framework) → counters merged;
 *  - a manifest of the other framework (a mixed project: Jest and Vitest
 *    tests both load the file) → merged by line, so a line either
 *    framework ran stays covered (statement ids differ between the two);
 *  - otherwise (the file changed) → the new counters alone.
 */
export function combineWithEntry(
  existing: CoverageEntry | undefined,
  manifestPath: string,
  manifest: Manifest,
  counters: FileCov,
): LiveCov {
  if (!existing || existing.state === 'counted') { return counters; }
  if (existing.manifestPath === manifestPath) { return mergeCounters(existing.counters, counters); }
  if (manifestSource(existing.manifestPath) === manifestSource(manifestPath)) { return counters; }
  const prev = readManifest(existing.manifestPath);
  return prev ? mergeByLine(prev, existing.counters, manifest, counters) : counters;
}

/**
 * `next`'s counters, plus what `prev` (another framework's instrumentation
 * of the same file) ran: a statement counts once a covered statement of
 * `prev` starts on its line — or a function `prev` called starts or ends
 * there (Vitest's v8 coverage has a statement for the `function f() {` and
 * `}` lines, Jest's babel instrumentation only for the body) —, a function
 * once a called one starts there, a branch arm once the same arm of a branch
 * on that line (same arm count) ran.
 */
export function mergeByLine(prev: Manifest, prevCov: LiveCov, next: Manifest, nextCov: FileCov): LiveCov {
  const ranLines = new Set<number>();
  for (const [id, st] of Object.entries(prev.statements)) {
    if ((prevCov.s[id] ?? 0) > 0) { ranLines.add(st.start.line); }
  }
  const calledLines = new Set<number>();
  for (const [id, fn] of Object.entries(prev.functions)) {
    if ((prevCov.f[id] ?? 0) > 0) {
      calledLines.add(fn.start.line);
      ranLines.add(fn.start.line);
      ranLines.add(fn.end.line);
    }
  }
  const armsByLine = new Map<string, number[]>();
  for (const [id, br] of Object.entries(prev.branches)) {
    const k = `${br.line}:${br.arms}`;
    const arms = prevCov.b[id] ?? [];
    const was = armsByLine.get(k);
    armsByLine.set(k, was ? was.map((v, i) => Math.max(v, arms[i] ?? 0)) : [...arms]);
  }
  const s: Record<string, number> = {};
  for (const [id, st] of Object.entries(next.statements)) {
    const n = nextCov.s[id] ?? 0;
    s[id] = n > 0 ? n : ranLines.has(st.start.line) ? 1 : 0;
  }
  const f: Record<string, number> = {};
  for (const [id, fn] of Object.entries(next.functions)) {
    const n = nextCov.f[id] ?? 0;
    f[id] = n > 0 ? n : calledLines.has(fn.start.line) ? 1 : 0;
  }
  const b: Record<string, number[]> = {};
  for (const [id, br] of Object.entries(next.branches)) {
    const arms = nextCov.b[id] ?? new Array<number>(br.arms).fill(0);
    const other = armsByLine.get(`${br.line}:${br.arms}`);
    b[id] = arms.map((v, i) => (v > 0 ? v : (other?.[i] ?? 0) > 0 ? 1 : 0));
  }
  return { s, f, b };
}
