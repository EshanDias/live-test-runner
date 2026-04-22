/**
 * Shared types for the coverage subsystem.
 *
 * Manifest — written by sessionTraceTransform.js for each source file it instruments.
 * LiveCov   — counter snapshot written by sessionTraceRuntime.js on process exit.
 * CoveragePct — four-metric summary stored in CoverageStore and rendered in the badge.
 * CoverageEntry — the three lifecycle states an entry can be in.
 */

/** Coverage manifest written to disk by sessionTraceTransform.js */
export interface Manifest {
  filePath: string;
  statements: Record<string, { start: { line: number; col: number }; end: { line: number; col: number } }>;
  branches: Record<string, { type: string; line: number; arms: number }>;
  functions: Record<string, { name: string; start: { line: number }; end: { line: number } }>;
}

/** Per-file counter object stored in globalThis.__cov[fileHash] */
export interface FileCov {
  s: Record<string, number>;
  b: Record<string, number[]>;
  f: Record<string, number>;
}

/** Counter snapshot written per Jest worker to COVERAGE_OUTPUT_FILE */
export interface LiveCov {
  s: Record<string, number>;
  b: Record<string, number[]>;
  f: Record<string, number>;
}

/** Four-metric coverage percentages for a single file */
export interface CoveragePct {
  statements: { covered: number; total: number; pct: number };
  branches:   { covered: number; total: number; pct: number };
  functions:  { covered: number; total: number; pct: number };
  lines:      { covered: number; total: number; pct: number };
}

/** Aggregate totals across all files */
export interface CoverageTotals {
  statements: { covered: number; total: number; pct: number };
  branches:   { covered: number; total: number; pct: number };
  functions:  { covered: number; total: number; pct: number };
  lines:      { covered: number; total: number; pct: number };
  scanComplete: boolean;
}

export type CoverageEntry =
  | { state: 'counted';        statements: number; branches: number; functions: number; lines: number }
  | { state: 'measured';       manifestPath: string; counters: LiveCov; pct: CoveragePct }
  | { state: 'measured-stale'; manifestPath: string; counters: LiveCov; pct: CoveragePct };
