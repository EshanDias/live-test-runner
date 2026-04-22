import { Manifest, FileCov, CoveragePct } from './types';

/** Calculate four coverage metrics from a manifest + live counters. Stateless. */
export function calculate(manifest: Manifest, counters: FileCov): CoveragePct {
  const stmtIds   = Object.keys(manifest.statements);
  const stmtsCov  = stmtIds.filter((id) => (counters.s[id] ?? 0) > 0).length;

  let branchTotal = 0;
  let branchCov   = 0;
  for (const [id, b] of Object.entries(manifest.branches)) {
    branchTotal += b.arms;
    branchCov   += (counters.b[id] ?? []).filter((n) => n > 0).length;
  }

  const fnIds  = Object.keys(manifest.functions);
  const fnsCov = fnIds.filter((id) => (counters.f[id] ?? 0) > 0).length;

  const allLines = new Set(Object.values(manifest.statements).map((s) => s.start.line));
  const covLines = new Set(
    stmtIds
      .filter((id) => (counters.s[id] ?? 0) > 0)
      .map((id) => manifest.statements[id].start.line),
  );

  return {
    statements: { covered: stmtsCov,   total: stmtIds.length,  pct: _pct(stmtsCov, stmtIds.length) },
    branches:   { covered: branchCov,  total: branchTotal,      pct: _pct(branchCov, branchTotal) },
    functions:  { covered: fnsCov,     total: fnIds.length,     pct: _pct(fnsCov, fnIds.length) },
    lines:      { covered: covLines.size, total: allLines.size,  pct: _pct(covLines.size, allLines.size) },
  };
}

function _pct(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
}
