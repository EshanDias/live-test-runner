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
import { CoverageStore, MeasuredFile } from './CoverageStore';
import { calculate } from './CoverageReport';
import { combineWithEntry, isExcludedFromCoverage } from './coverageRules';
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
 * An istanbul coverage map as measured files: each file version gets one
 * manifest on disk (named by the file path and its maps).
 */
export function measuredFiles(
  coverage: Record<string, IstanbulFileCoverage>,
  manifestDir: string,
  projectRoot: string,
  /** Whether a file counts toward coverage (the project's coverage settings); default: the built-in rules. */
  counts: (filePath: string) => boolean = (fp) => !isExcludedFromCoverage(path.relative(projectRoot, fp)),
): { files: Map<string, MeasuredFile>; excluded: number } {
  fs.mkdirSync(manifestDir, { recursive: true });
  const files = new Map<string, MeasuredFile>();
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
    files.set(filePath, { manifestPath, manifest, counters });
  }
  return { files, excluded };
}

/**
 * Adds a merged coverage map (one per batch) to the store: runs of the same
 * file version merge their counters (the higher count wins) and a changed
 * file starts over. Frameworks that report per test file use
 * CoverageStore.replaceContribution instead.
 *
 * @returns how many files were measured / left out
 */
export function applyIstanbulCoverage(
  coverage: Record<string, IstanbulFileCoverage>,
  store: CoverageStore,
  manifestDir: string,
  projectRoot: string,
  counts?: (filePath: string) => boolean,
): { measured: number; excluded: number } {
  const { files, excluded } = measuredFiles(coverage, manifestDir, projectRoot, counts);
  for (const [filePath, mf] of files) {
    // Same version → counters merged; a Jest-measured entry (mixed project) → merged by line.
    const merged: LiveCov = combineWithEntry(store.getEntry(filePath), mf.manifestPath, mf.manifest, mf.counters);
    store.setMeasuredEntry(filePath, { manifestPath: mf.manifestPath, counters: merged, pct: calculate(mf.manifest, merged) });
  }
  log.debug(`${files.size} file(s) measured from Vitest coverage, ${excluded} excluded`);
  return { measured: files.size, excluded };
}
