/**
 * Istanbul coverage (`coverage-final.json`, as Vitest's v8 and istanbul
 * providers write it) into the CoverageStore — the same manifest + counters
 * model the Jest instrumentation produces, so the gutter, hover and totals
 * need no change.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fromRunnerPath } from '@live-test-runner/runner';
import { CoverageStore } from './CoverageStore';
import { calculate } from './CoverageReport';
import { isExcludedFromCoverage, mergeCounters } from './coverageRules';
import { FileCov, LiveCov, Manifest } from './types';
import { logger } from '../utils/logger';

const log = logger.scope('Coverage');

interface Loc { line: number; column: number }
interface Range { start: Loc; end: Loc }

/** One file of an istanbul coverage map. */
export interface IstanbulFileCoverage {
  path: string;
  statementMap: Record<string, Range>;
  fnMap: Record<string, { name: string; decl?: Range; loc: Range; line?: number }>;
  branchMap: Record<string, { type: string; loc?: Range; locations: Range[]; line?: number }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

/** The manifest (structure) of one istanbul file entry. */
export function toManifest(fc: IstanbulFileCoverage, filePath: string): Manifest {
  const statements: Manifest['statements'] = {};
  for (const [id, r] of Object.entries(fc.statementMap ?? {})) {
    statements[id] = { start: { line: r.start.line, col: r.start.column }, end: { line: r.end.line, col: r.end.column } };
  }
  const branches: Manifest['branches'] = {};
  for (const [id, b] of Object.entries(fc.branchMap ?? {})) {
    branches[id] = { type: b.type, line: b.loc?.start.line ?? b.line ?? b.locations[0]?.start.line ?? 0, arms: b.locations.length };
  }
  const functions: Manifest['functions'] = {};
  for (const [id, f] of Object.entries(fc.fnMap ?? {})) {
    functions[id] = { name: f.name, start: { line: (f.decl ?? f.loc).start.line }, end: { line: f.loc.end.line } };
  }
  return { filePath, statements, branches, functions };
}

/**
 * Adds a coverage map to the store. Each file version gets one manifest
 * (named by the file path and its maps), so runs of the same version merge
 * their counters (the higher count wins) and a changed file starts over.
 *
 * @returns how many files were measured / left out
 */
export function applyIstanbulCoverage(
  coverage: Record<string, IstanbulFileCoverage>,
  store: CoverageStore,
  manifestDir: string,
  projectRoot: string,
  /** Whether a file counts toward coverage (the project's coverage settings); default: the built-in rules. */
  counts: (filePath: string) => boolean = (fp) => !isExcludedFromCoverage(path.relative(projectRoot, fp)),
): { measured: number; excluded: number } {
  fs.mkdirSync(manifestDir, { recursive: true });
  let measured = 0;
  let excluded = 0;
  for (const [key, fc] of Object.entries(coverage)) {
    // The editor's spelling of the path (symlinks resolved back, lower-case drive) — like Jest's entries.
    const filePath = fromRunnerPath(fc.path || key).replace(/^[A-Z]:/, (m) => m.toLowerCase());
    if (!counts(filePath)) { excluded++; continue; }

    const manifest = toManifest(fc, filePath);
    const hash = crypto.createHash('sha1')
      .update(filePath).update('\0')
      .update(JSON.stringify([fc.statementMap, fc.branchMap, fc.fnMap]))
      .digest('hex');
    const manifestPath = path.join(manifestDir, `${hash}.json`);
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }

    const counters: FileCov = { s: { ...fc.s }, f: { ...fc.f }, b: Object.fromEntries(Object.entries(fc.b ?? {}).map(([id, arms]) => [id, [...arms]])) };
    const existing = store.getEntry(filePath);
    const merged: LiveCov = existing && existing.state !== 'counted' && existing.manifestPath === manifestPath
      ? mergeCounters(existing.counters, counters)
      : counters;
    store.setMeasuredEntry(filePath, { manifestPath, counters: merged, pct: calculate(manifest, merged) });
    measured++;
  }
  log.debug(`${measured} file(s) measured from Vitest coverage, ${excluded} excluded`);
  return { measured, excluded };
}
