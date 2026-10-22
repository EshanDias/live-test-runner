/**
 * Coverage rules shared by every framework's batch runner, so a file counts
 * the same way whichever framework measured it.
 */
import { FileCov, LiveCov } from './types';

/** Files that never count toward coverage (tests, configs, build output, dependencies). */
const COVERAGE_EXCLUDE_RE = [
  /[/\\]node_modules[/\\]/,
  /\.(test|spec)\.(js|ts|jsx|tsx)$/,
  /[/\\](__tests__|__mocks__|tests?|specs?)[/\\]/,
  /\.config\.(js|ts|mjs|cjs)$/,
  /\.d\.ts$/,
  /[/\\](dist|build|out|\.next|coverage)[/\\]/,
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
