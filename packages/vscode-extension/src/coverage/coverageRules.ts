/**
 * Coverage rules shared by every framework's batch runner, so a file counts
 * the same way whichever framework measured it.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CoverageEntry, FileCov, IstanbulRange, LiveCov, Manifest } from './types';

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

/** A copy of a counter set. */
export function cloneCounters(c: FileCov): FileCov {
  return {
    s: { ...c.s },
    f: { ...c.f },
    b: Object.fromEntries(Object.entries(c.b ?? {}).map(([id, arms]) => [id, [...(arms as number[])]])),
  };
}

/** The same counters, all zero (the file's structure without hits). */
export function zeroCounters(c: FileCov): FileCov {
  return {
    s: Object.fromEntries(Object.keys(c.s ?? {}).map((id) => [id, 0])),
    f: Object.fromEntries(Object.keys(c.f ?? {}).map((id) => [id, 0])),
    b: Object.fromEntries(Object.entries(c.b ?? {}).map(([id, arms]) => [id, (arms as number[]).map(() => 0)])),
  };
}

/** Two counter sets of the same file version added up (two runs of it within one test file's coverage, e.g. two Jest projects). */
export function sumCounters(a: FileCov, b: FileCov): FileCov {
  const out = cloneCounters(a);
  for (const [id, n] of Object.entries(b.s ?? {})) { out.s[id] = (out.s[id] ?? 0) + n; }
  for (const [id, n] of Object.entries(b.f ?? {})) { out.f[id] = (out.f[id] ?? 0) + n; }
  for (const [id, arms] of Object.entries(b.b ?? {})) {
    const cur = out.b[id] ?? new Array<number>((arms as number[]).length).fill(0);
    out.b[id] = (arms as number[]).map((n, i) => (cur[i] ?? 0) + n);
  }
  return out;
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

/**
 * Two istanbul measurements of one file whose maps differ, merged as
 * istanbul-lib-coverage's `FileCoverage.merge` merges them — what the
 * framework's own report does with them (Vitest's v8 maps depend on what each
 * test file ran: two test files give two maps of one file). Items at the same
 * location add their hits; an item only one side has keeps its hits plus those
 * of the narrowest item of the other side that contains it. Undefined when a
 * manifest has no istanbul locations (Jest's own instrumentation).
 */
export function mergeIstanbul(a: Manifest, ac: FileCov, b: Manifest, bc: FileCov): { manifest: Manifest; counters: LiveCov } | undefined {
  if (!a.locs || !b.locs) { return undefined; }
  const manifest: Manifest = { filePath: b.filePath, statements: {}, branches: {}, functions: {}, locs: { s: {}, f: {}, b: {} } };
  const counters: LiveCov = { s: {}, f: {}, b: {} };

  const s = mergeProp(a.statements, a.locs.s, (id) => ac.s[id] ?? 0, b.statements, b.locs.s, (id) => bc.s[id] ?? 0);
  s.forEach(([hits, item, loc], i) => { manifest.statements[i] = item; manifest.locs!.s[i] = loc; counters.s[i] = hits; });
  const f = mergeProp(a.functions, a.locs.f, (id) => ac.f[id] ?? 0, b.functions, b.locs.f, (id) => bc.f[id] ?? 0);
  f.forEach(([hits, item, loc], i) => { manifest.functions[i] = item; manifest.locs!.f[i] = loc; counters.f[i] = hits; });
  const arms = (m: Manifest, c: FileCov) => (id: string) => c.b[id] ?? new Array<number>(m.branches[id].arms).fill(0);
  const br = mergeProp(a.branches, a.locs.b, arms(a, ac), b.branches, b.locs.b, arms(b, bc));
  br.forEach(([hits, item, loc], i) => { manifest.branches[i] = item; manifest.locs!.b[i] = loc; counters.b[i] = hits; });
  return { manifest, counters };
}

type Hits = number | number[];

function mergeProp<T, H extends Hits>(
  aMap: Record<string, T>, aLocs: Record<string, IstanbulRange>, aHits: (id: string) => H,
  bMap: Record<string, T>, bLocs: Record<string, IstanbulRange>, bHits: (id: string) => H,
): Array<[H, T, IstanbulRange]> {
  const items = (map: Record<string, T>, locs: Record<string, IstanbulRange>, hits: (id: string) => H) => {
    const out = new Map<string, [H, T, IstanbulRange]>();
    for (const id of Object.keys(map)) {
      const loc = locs[id];
      if (loc) { out.set(locKey(loc), [hits(id), map[id], loc]); }
    }
    return out;
  };
  const aItems = items(aMap, aLocs, aHits);
  const bItems = items(bMap, bLocs, bHits);
  const merged = new Map<string, [H, T, IstanbulRange]>();
  for (const [key, [hits, item, loc]] of aItems) {
    const other = bItems.get(key);
    merged.set(key, [other ? addHits(hits, other[0]) : addNearestContainerHits(loc, hits, bItems), item, loc]);
  }
  for (const [key, [hits, item, loc]] of bItems) {
    if (merged.has(key)) { continue; }
    merged.set(key, [addNearestContainerHits(loc, hits, aItems), item, loc]);
  }
  return [...merged.values()];
}

function locKey({ start, end }: IstanbulRange): string {
  return `${start.line}|${start.column}|${end.line}|${end.column}`;
}

function addHits<H extends Hits>(a: H, b: H): H {
  if (typeof a === 'number' && typeof b === 'number') { return (a + b) as H; }
  if (Array.isArray(a) && Array.isArray(b)) { return a.map((n, i) => (n || 0) + (b[i] || 0)) as H; }
  return a;
}

/** The hits of the narrowest item of `others` containing `loc` added (closer line before closer column), as istanbul does. */
function addNearestContainerHits<T, H extends Hits>(loc: IstanbulRange, hits: H, others: Map<string, [H, T, IstanbulRange]>): H {
  let nearest: [H, T, IstanbulRange] | undefined;
  let best: number[] | undefined;
  for (const other of others.values()) {
    const o = other[2];
    const d = [loc.start.line - o.start.line, loc.start.column - o.start.column, o.end.line - loc.end.line, o.end.column - loc.end.column];
    if (d[0] < 0 || d[2] < 0 || (d[0] === 0 && d[1] < 0) || (d[2] === 0 && d[3] < 0)) { continue; }
    if (!best) { nearest = other; best = d; continue; }
    const closerBefore = d[0] < best[0] || (d[0] === 0 && d[1] < best[1]);
    const closerAfter = d[2] < best[2] || (d[2] === 0 && d[3] < best[3]);
    if (closerBefore || closerAfter) { nearest = other; best = d; }
  }
  return nearest ? addHits(hits, nearest[0]) : hits;
}

/** A manifest written once, named by its content, in `dir`; returns its path. */
export function writeManifest(dir: string, manifest: Manifest): string {
  const json = JSON.stringify(manifest);
  const file = path.join(dir, `${crypto.createHash('sha1').update(json).digest('hex')}.json`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, json, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Already written (same name = same content).
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
  }
  return file;
}
