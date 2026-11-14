import type { LiveCov, Manifest } from './types';
import { statementLines } from './statementLines';

export type LineState = 'covered' | 'partial' | 'uncovered';

/**
 * Each executable line's coverage (1-based), as the editor's bars show it:
 * a line whose statements never ran is uncovered; one that ran but has a
 * branch arm that never ran is partial; else covered. Shared by the coverage
 * bars and the AI-assistant answers so both always agree.
 */
export function lineStates(manifest: Manifest, counters: LiveCov): Map<number, LineState> {
  // Line → max statement hit count across the statements on it (a statement spanning lines marks each: statementLines)
  const lineHits = new Map<number, number>();
  for (const [line, ids] of statementLines(manifest)) {
    lineHits.set(line, Math.max(...ids.map((id) => counters.s[id] ?? 0)));
  }
  // Line → { total branch arms, covered arms } — only lines that have branches
  const lineBranches = new Map<number, { total: number; covered: number }>();
  for (const [id, branch] of Object.entries(manifest.branches)) {
    const arms = counters.b[id] ?? [];
    const covered = arms.filter((n) => n > 0).length;
    const prev = lineBranches.get(branch.line) ?? { total: 0, covered: 0 };
    lineBranches.set(branch.line, { total: prev.total + branch.arms, covered: prev.covered + covered });
  }
  const out = new Map<number, LineState>();
  for (const [line, hits] of lineHits) {
    if (hits === 0) { out.set(line, 'uncovered'); continue; }
    const b = lineBranches.get(line);
    out.set(line, b && b.covered < b.total ? 'partial' : 'covered');
  }
  return out;
}
