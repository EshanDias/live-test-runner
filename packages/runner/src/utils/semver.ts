/**
 * Just enough semver for `engines.node` ranges and framework versions — the
 * runner has no dependencies, so no `semver` package.
 *
 * Supports `a || b`, space-joined comparator sets, `^`, `~`, `>=`, `>`, `<=`,
 * `<`, `=`, bare versions and `x`/`*` wildcards (`22.x`, `>=22`).
 */

export type Version = [number, number, number];

/** `v22.12.0`, `5.0.5`, `4.1.0-beta.1` → [major, minor, patch]; undefined if not a version. */
export function parseVersion(text: string | undefined): Version | undefined {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text ?? '');
  if (!m) { return undefined; }
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` satisfies `range`. Returns undefined when the range uses
 * syntax this helper does not understand — callers treat that as "unknown",
 * never as a failure.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) { return undefined; }
  let unknown = false;
  for (const set of range.split('||')) {
    const comparators = set.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) { return true; } // "" or "*" style: anything goes
    const results = comparators.map((c) => testComparator(v, c));
    if (results.includes(undefined)) { unknown = true; continue; }
    if (results.every(Boolean)) { return true; }
  }
  return unknown ? undefined : false;
}

function testComparator(v: Version, comparator: string): boolean | undefined {
  if (comparator === '*' || comparator === 'x') { return true; }
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[\w.]+)?$/i.exec(comparator);
  if (!m) { return undefined; }
  const op = m[1] ?? '=';
  const parts = [m[2], m[3], m[4]];
  const wild = parts.findIndex((p) => p === undefined || /^[x*]$/i.test(p));
  const nums = parts.map((p) => (p === undefined || /^[x*]$/i.test(p) ? 0 : Number(p))) as Version;
  const cmp = compareVersions(v, nums);

  // Upper bound (exclusive) for partial versions, ^ and ~.
  const bump = (i: number): Version => {
    const b: Version = [...nums];
    b[i] += 1;
    for (let j = i + 1; j < 3; j++) { b[j] = 0; }
    return b;
  };
  const within = (upper: Version) => cmp >= 0 && compareVersions(v, upper) < 0;

  switch (op) {
    case '^': {
      const i = nums[0] > 0 || wild === 1 ? 0 : nums[1] > 0 || wild === 2 ? 1 : 2;
      return within(bump(i));
    }
    case '~':
      return within(bump(wild === 1 ? 0 : 1));
    case '>=': return cmp >= 0;
    case '>':  return wild >= 0 ? compareVersions(v, bump(wild - 1)) >= 0 : cmp > 0;
    case '<':  return cmp < 0;
    case '<=': return wild >= 0 ? compareVersions(v, bump(wild - 1)) < 0 : cmp <= 0;
    default:   return wild >= 0 ? (wild === 0 ? true : within(bump(wild - 1))) : cmp === 0;
  }
}
