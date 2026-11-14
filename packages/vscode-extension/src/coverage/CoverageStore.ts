import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CoverageEntry, CoveragePct, CoverageTotals, FileCov, LiveCov, Manifest } from './types';
import { calculate } from './CoverageReport';
import { mergeByLine, mergeIstanbul, writeManifest } from './coverageRules';
import { logger } from '../utils/logger';

const log = logger.scope('Coverage');

/** One source file as one test file's run measured it. */
export interface MeasuredFile {
  manifestPath: string;
  manifest: Manifest;
  counters: FileCov;
}

/**
 * Coverage of the session, kept truthful as tests and files change.
 *
 * Every test file's latest run is one **contribution**: the counters it
 * produced per source file and version (manifest). A rerun of the test file
 * replaces its contribution (the old counters are subtracted, the new ones
 * added), so coverage goes down as well as up: a deleted test, a test file
 * that no longer imports a module, code that no longer calls another file.
 *
 * Per source file and version the store keeps the summed counters of its
 * contributors. A version is **current** when it was measured after the
 * file last changed (`markSourceChanged`); the entry shows the current
 * versions (merged by line when several, e.g. Jest and Vitest), else the
 * newest older one as `measured-stale` until the test files behind it run
 * again (`outdatedContributors`), else the source scan's count (0 hits).
 *
 * Contributions live on disk in the session folder (`setContributionDir`),
 * so memory holds one summed counter set per source version, not one per
 * test file. Without a folder (unit tests) they stay in memory.
 *
 * `setMeasuredEntry` is the older path (a framework that reports one merged
 * coverage per batch): counters merged by the caller, no contributions.
 */
export class CoverageStore {
  /** Measured sources: versions with their contributors. */
  private readonly _ledgers = new Map<string, Ledger>();
  /** Source-scan counts (0 hits): what a file shows when nothing measured it. */
  private readonly _counted = new Map<string, Counts>();
  /** Entries written by the per-batch path (setMeasuredEntry). */
  private readonly _batchEntries = new Map<string, CoverageEntry>();
  /** Contributions without a folder (unit tests): contributor → files. */
  private readonly _memContrib = new Map<string, StoredContribution>();
  /** Every test file with a contribution (their files are named by hash on disk). */
  private readonly _contributors = new Set<string>();
  private _contribDir: string | undefined;
  private _scanComplete = false;
  private _off: string[] = [];
  /** Test files whose run produced results but no coverage (a plain fallback run). */
  private readonly _unmeasured = new Set<string>();

  readonly onDidChange = new vscode.EventEmitter<void>();
  private _fireTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Setup ───────────────────────────────────────────────────────────────────

  /** Where contributions are kept (the session folder); cleared with the store. */
  setContributionDir(dir: string | undefined): void {
    this._contribDir = dir;
    if (dir) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { log.error(`Could not create ${dir} — coverage contributions stay in memory`, err); this._contribDir = undefined; }
    }
  }

  // ── Writes: contributions ───────────────────────────────────────────────────

  /**
   * The test file's run measured `files` (every source file it covered,
   * nothing else): replaces whatever it contributed before. An empty map
   * removes its contribution (it covers nothing now).
   * @param seenAt when the run started (a version is current only when measured after the file's last change)
   */
  replaceContribution(contributor: string, files: Map<string, MeasuredFile>, seenAt: number): void {
    this._unmeasured.delete(contributor);
    this._subtract(contributor, this._readContribution(contributor));
    const stored: StoredContribution = {};
    for (const [filePath, mf] of files) {
      const sparse = sparseCounters(mf.counters);
      stored[filePath] = { m: mf.manifestPath, ...sparse };
      const ledger = this._ledger(filePath);
      let version = ledger.versions.get(mf.manifestPath);
      if (!version) {
        version = { manifestPath: mf.manifestPath, seenAt, sum: { s: {}, b: {}, f: {} }, contributors: new Set(), pct: undefined };
        ledger.versions.set(mf.manifestPath, version);
      }
      version.seenAt = Math.max(version.seenAt, seenAt);
      version.contributors.add(contributor);
      addCounters(version.sum, sparse, 1);
      version.pct = calculate(mf.manifest, version.sum);
      ledger.entry = undefined;
    }
    this._writeContribution(contributor, stored);
    if (Object.keys(stored).length > 0) { this._contributors.add(contributor); } else { this._contributors.delete(contributor); }
    this._changed();
  }

  /** The test file is gone (deleted, or no longer a test file): its coverage no longer counts. */
  removeContribution(contributor: string): void {
    this._unmeasured.delete(contributor);
    const old = this._readContribution(contributor);
    if (Object.keys(old).length === 0) { return; }
    this._subtract(contributor, old);
    this._writeContribution(contributor, undefined);
    this._contributors.delete(contributor);
    this._changed();
  }

  /**
   * A file or folder was deleted: source files under it leave the totals,
   * test files under it no longer contribute.
   */
  removePath(deleted: string): void {
    const under = (p: string) => p === deleted || p.startsWith(deleted.endsWith(path.sep) ? deleted : deleted + path.sep);
    for (const c of [...this._contributors]) { if (c.split('\n').some(under)) { this.removeContribution(c); } }
    for (const fp of this._files()) { if (under(fp)) { this.removeSource(fp); } }
  }

  /** The test file ran without coverage (a plain fallback run): its old contribution stays, and the Coverage tab says some files were not measured. */
  markUnmeasured(contributor: string): void {
    if (this._unmeasured.has(contributor)) { return; }
    this._unmeasured.add(contributor);
    this._changed();
  }

  /** Test files whose latest run had no coverage. */
  unmeasuredContributors(): string[] {
    return [...this._unmeasured];
  }

  // ── Writes: source files ────────────────────────────────────────────────────

  /**
   * Static count from the source scan (0 hits): shown while nothing measured
   * the file. The scan runs alongside the first test run, so a file may
   * already be measured — the measurement keeps priority.
   */
  setCountedEntry(
    filePath: string,
    counts: { statements: number; branches: number; functions: number; lines: number },
  ): void {
    this._counted.set(filePath, { ...counts });
    this._changed();
  }

  /** The file changed (saved, or changed on disk): what was measured before is outdated until its tests run again. */
  markSourceChanged(filePath: string, at: number = Date.now()): void {
    const ledger = this._ledgers.get(filePath);
    if (ledger) {
      ledger.changedAt = Math.max(ledger.changedAt, at);
      ledger.entry = undefined;
      log.trace(`Changed: ${filePath}`);
    }
    const batch = this._batchEntries.get(filePath);
    if (batch?.state === 'measured') {
      this._batchEntries.set(filePath, { ...batch, state: 'measured-stale' });
      if (ledger) { ledger.entry = undefined; }
    }
    this._changed();
  }

  /** The file is gone (deleted or renamed away): it leaves the totals. Contributions naming it are left as they are; they no longer count. */
  removeSource(filePath: string): void {
    const had = this._ledgers.delete(filePath) || this._counted.delete(filePath) || this._batchEntries.delete(filePath);
    this._counted.delete(filePath);
    this._batchEntries.delete(filePath);
    if (had) { log.trace(`Removed: ${filePath}`); this._changed(); }
  }

  // ── Writes: the per-batch path (frameworks without per-test-file data) ──────

  setMeasuredEntry(
    filePath: string,
    data: { manifestPath: string; counters: LiveCov; pct: CoveragePct },
  ): void {
    this._batchEntries.set(filePath, { state: 'measured', ...data });
    const ledger = this._ledgers.get(filePath);
    if (ledger) { ledger.entry = undefined; }
    log.trace(
      `${filePath}: stmts ${data.pct.statements.covered}/${data.pct.statements.total}, ` +
      `branches ${data.pct.branches.covered}/${data.pct.branches.total}, ` +
      `fns ${data.pct.functions.covered}/${data.pct.functions.total}, ` +
      `lines ${data.pct.lines.covered}/${data.pct.lines.total}`,
    );
    this._changed();
  }

  /** Per-batch path: the file was saved; its counters are outdated until it is measured again. */
  markFileStale(filePath: string): void {
    this.markSourceChanged(filePath);
  }

  /**
   * Per-batch path: the save's rerun is over. Measured-by-contribution files
   * clear by themselves once their tests ran again (or stay marked: what is
   * shown was measured before the change).
   */
  clearStale(filePath: string): void {
    const entry = this._batchEntries.get(filePath);
    if (entry?.state === 'measured-stale') {
      this._batchEntries.set(filePath, { ...entry, state: 'measured' });
      const ledger = this._ledgers.get(filePath);
      if (ledger) { ledger.entry = undefined; }
      this._changed();
    }
  }

  markScanComplete(): void {
    this._scanComplete = true;
    this._changed();
  }

  /** Why coverage is off this session (see CoverageTotals.off); [] when it is measured. */
  setOffReasons(reasons: string[]): void {
    this._off = [...reasons];
    this._changed();
  }

  clear(): void {
    this._ledgers.clear();
    this._counted.clear();
    this._batchEntries.clear();
    this._memContrib.clear();
    this._contributors.clear();
    this._unmeasured.clear();
    if (this._contribDir) {
      try { fs.rmSync(this._contribDir, { recursive: true, force: true }); fs.mkdirSync(this._contribDir, { recursive: true }); } catch { /* a new folder next session */ }
    }
    this._scanComplete = false;
    this._off = [];
    if (this._fireTimer) { clearTimeout(this._fireTimer); this._fireTimer = undefined; }
    this.onDidChange.fire();
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  getEntry(filePath: string): CoverageEntry | undefined {
    const ledger = this._ledgers.get(filePath);
    const batch = this._batchEntries.get(filePath);
    if (ledger && ledger.versions.size > 0) {
      if (!ledger.entry) {
        ledger.entry = entryOf(ledger);
        // Another framework measured the file per batch (a mixed project): a line either one ran counts.
        if (ledger.entry && ledger.entry.state !== 'counted' && batch && batch.state !== 'counted' && batch.manifestPath !== ledger.entry.manifestPath) {
          ledger.entry = mergeEntries(batch, ledger.entry);
        }
      }
      if (ledger.entry) { return ledger.entry; }
    }
    if (batch) { return batch; }
    const counted = this._counted.get(filePath);
    return counted ? { state: 'counted', ...counted } : undefined;
  }

  getAllEntries(): IterableIterator<[string, CoverageEntry]> {
    const out = new Map<string, CoverageEntry>();
    for (const fp of this._files()) {
      const e = this.getEntry(fp);
      if (e) { out.set(fp, e); }
    }
    return out.entries();
  }

  /**
   * Test files whose contribution was measured before a source file they
   * cover last changed: they must run again (whole) for coverage to be current.
   */
  outdatedContributors(): string[] {
    const out = new Set<string>();
    for (const ledger of this._ledgers.values()) {
      for (const v of ledger.versions.values()) {
        if (v.seenAt < ledger.changedAt) { for (const c of v.contributors) { out.add(c); } }
      }
    }
    return [...out];
  }

  /** Test files that contributed to any version of the file. */
  contributorsOf(filePath: string): string[] {
    const out = new Set<string>();
    for (const v of this._ledgers.get(filePath)?.versions.values() ?? []) {
      for (const c of v.contributors) { out.add(c); }
    }
    return [...out];
  }

  isScanComplete(): boolean {
    return this._scanComplete;
  }

  isAllMeasured(): boolean {
    for (const [, entry] of this.getAllEntries()) {
      if (entry.state === 'counted') { return false; }
    }
    return true;
  }

  getTotals(): CoverageTotals {
    let stmtsCovered = 0, stmtsTotal = 0;
    let branchCovered = 0, branchTotal = 0;
    let fnsCovered = 0, fnsTotal = 0;
    let linesCovered = 0, linesTotal = 0;
    let stale = 0;

    for (const [, entry] of this.getAllEntries()) {
      if (entry.state === 'counted') {
        stmtsTotal  += entry.statements;
        branchTotal += entry.branches;
        fnsTotal    += entry.functions;
        linesTotal  += entry.lines;
      } else {
        if (entry.state === 'measured-stale') { stale++; }
        const p = entry.pct;
        stmtsCovered  += p.statements.covered;
        stmtsTotal    += p.statements.total;
        branchCovered += p.branches.covered;
        branchTotal   += p.branches.total;
        fnsCovered    += p.functions.covered;
        fnsTotal      += p.functions.total;
        linesCovered  += p.lines.covered;
        linesTotal    += p.lines.total;
      }
    }

    return {
      statements: { covered: stmtsCovered, total: stmtsTotal, pct: _pct(stmtsCovered, stmtsTotal) },
      branches:   { covered: branchCovered, total: branchTotal, pct: _pct(branchCovered, branchTotal) },
      functions:  { covered: fnsCovered, total: fnsTotal, pct: _pct(fnsCovered, fnsTotal) },
      lines:      { covered: linesCovered, total: linesTotal, pct: _pct(linesCovered, linesTotal) },
      scanComplete: this._scanComplete,
      ...(stale > 0 ? { updating: stale } : {}),
      ...(this._unmeasured.size > 0 ? { unmeasuredTestFiles: this._unmeasured.size } : {}),
      ...(this._off.length > 0 ? { off: [...this._off] } : {}),
    };
  }

  getFileRows(): Array<{ filePath: string; state: string; pct: CoveragePct }> {
    const rows: Array<{ filePath: string; state: string; pct: CoveragePct }> = [];
    for (const [filePath, entry] of this.getAllEntries()) {
      if (entry.state === 'measured' || entry.state === 'measured-stale') {
        rows.push({ filePath, state: entry.state, pct: entry.pct });
      } else if (entry.state === 'counted') {
        // Skip files where Babel failed to parse (all zeros — nothing to show)
        if (entry.statements === 0 && entry.lines === 0 && entry.functions === 0) { continue; }
        // File scanned but not yet executed by any test — show as 0%
        const zero = (total: number) => ({ covered: 0, total, pct: 0 });
        rows.push({
          filePath,
          state: 'counted',
          pct: {
            statements: zero(entry.statements),
            branches:   zero(entry.branches),
            functions:  zero(entry.functions),
            lines:      zero(entry.lines),
          },
        });
      }
    }
    return rows;
  }

  dispose(): void {
    if (this._fireTimer) { clearTimeout(this._fireTimer); }
    this.onDidChange.dispose();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _files(): Set<string> {
    const out = new Set<string>(this._counted.keys());
    for (const k of this._batchEntries.keys()) { out.add(k); }
    for (const [k, l] of this._ledgers) { if (l.versions.size > 0) { out.add(k); } }
    return out;
  }

  private _ledger(filePath: string): Ledger {
    let ledger = this._ledgers.get(filePath);
    if (!ledger) {
      ledger = { versions: new Map(), changedAt: 0, entry: undefined };
      this._ledgers.set(filePath, ledger);
    }
    return ledger;
  }

  private _subtract(contributor: string, old: StoredContribution): void {
    for (const [filePath, c] of Object.entries(old)) {
      const ledger = this._ledgers.get(filePath);
      const version = ledger?.versions.get(c.m);
      if (!ledger || !version || !version.contributors.has(contributor)) { continue; }
      version.contributors.delete(contributor);
      ledger.entry = undefined;
      if (version.contributors.size === 0) {
        ledger.versions.delete(c.m);
        continue;
      }
      addCounters(version.sum, c, -1);
      version.pct = undefined;
    }
  }

  private _contribPath(contributor: string): string | undefined {
    if (!this._contribDir) { return undefined; }
    const name = crypto.createHash('sha1').update(contributor).digest('hex').slice(0, 20);
    return path.join(this._contribDir, `${name}.json`);
  }

  private _readContribution(contributor: string): StoredContribution {
    const p = this._contribPath(contributor);
    if (!p) { return this._memContrib.get(contributor) ?? {}; }
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; files: StoredContribution };
      return doc.id === contributor ? doc.files : {};
    } catch {
      return {};
    }
  }

  private _writeContribution(contributor: string, files: StoredContribution | undefined): void {
    const p = this._contribPath(contributor);
    if (!p) {
      if (files && Object.keys(files).length > 0) { this._memContrib.set(contributor, files); } else { this._memContrib.delete(contributor); }
      return;
    }
    try {
      if (files && Object.keys(files).length > 0) { fs.writeFileSync(p, JSON.stringify({ id: contributor, files })); } else { fs.rmSync(p, { force: true }); }
    } catch (err) {
      log.error(`Could not write the coverage of ${contributor} — its next rerun cannot take it back out`, err);
    }
  }

  /**
   * Coalesces change events: every fire re-sends all coverage rows to the
   * webview, and the source scan writes one entry per file — firing per entry
   * was O(N²) traffic on large repos.
   */
  private _changed(): void {
    if (this._fireTimer) { return; }
    this._fireTimer = setTimeout(() => {
      this._fireTimer = undefined;
      this.onDidChange.fire();
    }, CHANGE_DEBOUNCE_MS);
  }
}

interface Counts { statements: number; branches: number; functions: number; lines: number }

interface Version {
  manifestPath: string;
  /** Start of the newest run that measured this version. */
  seenAt: number;
  /** Summed counters of its contributors. */
  sum: LiveCov;
  contributors: Set<string>;
  /** undefined: recalculated (manifest read from disk) when next shown. */
  pct: CoveragePct | undefined;
}

interface Ledger {
  versions: Map<string, Version>;
  /** When the file last changed (0: not since the session started). */
  changedAt: number;
  entry: CoverageEntry | undefined;
}

/** On disk per contributor: source file → manifest + only the non-zero counters. */
type StoredContribution = Record<string, { m: string } & FileCov>;

/** The entry a ledger shows: its current versions (merged by line when several), else the newest older one, marked stale. */
function entryOf(ledger: Ledger): CoverageEntry | undefined {
  const versions = [...ledger.versions.values()].sort((a, b) => b.seenAt - a.seenAt);
  const current = versions.filter((v) => v.seenAt >= ledger.changedAt);
  const shown = current.length > 0 ? current : versions.slice(0, 1);
  const state = current.length > 0 ? 'measured' : 'measured-stale';
  if (shown.length === 1) {
    const v = shown[0];
    const pct = v.pct ?? pctOf(v);
    if (!pct) { return undefined; }
    v.pct = pct;
    return { state, manifestPath: v.manifestPath, counters: v.sum, pct };
  }
  // Several current versions. Istanbul maps of one framework that differ
  // (Vitest's v8 maps depend on what each test file ran): merged as the
  // framework's own report merges them. Else (Jest and Vitest both test the
  // file, or two Jest projects transform it differently): a line any of them
  // ran counts.
  let manifestPath = shown[0].manifestPath;
  const first = readManifest(manifestPath);
  if (!first) { return undefined; }
  let manifest: Manifest = first;
  let counters: LiveCov = shown[0].sum;
  for (const v of shown.slice(1)) {
    const next = readManifest(v.manifestPath);
    if (!next) { continue; }
    const sameTool = path.dirname(v.manifestPath) === path.dirname(manifestPath);
    const merged: { manifest: Manifest; counters: LiveCov } | undefined = sameTool ? mergeIstanbul(manifest, counters, next, v.sum) : undefined;
    if (merged) {
      manifest = merged.manifest;
      counters = merged.counters;
      manifestPath = writeManifest(path.dirname(v.manifestPath), manifest);
      continue;
    }
    counters = mergeByLine(manifest, counters, next, v.sum);
    manifest = next;
    manifestPath = v.manifestPath;
  }
  return { state, manifestPath, counters, pct: calculate(manifest, counters) };
}

type MeasuredEntry = Extract<CoverageEntry, { manifestPath: string }>;

/** Two measurements of one file by different frameworks, merged by line; stale when either is. */
function mergeEntries(a: MeasuredEntry, b: MeasuredEntry): CoverageEntry {
  const ma = readManifest(a.manifestPath);
  const mb = readManifest(b.manifestPath);
  if (!ma || !mb) { return b; }
  const counters = mergeByLine(ma, a.counters, mb, b.counters);
  const state = a.state === 'measured-stale' || b.state === 'measured-stale' ? 'measured-stale' : 'measured';
  return { state, manifestPath: b.manifestPath, counters, pct: calculate(mb, counters) };
}

function pctOf(v: Version): CoveragePct | undefined {
  const manifest = readManifest(v.manifestPath);
  return manifest ? calculate(manifest, v.sum) : undefined;
}

function readManifest(manifestPath: string): Manifest | undefined {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest; } catch { return undefined; }
}

/** Only the non-zero counters (branch arrays keep their length). */
function sparseCounters(c: FileCov): FileCov {
  const s: Record<string, number> = {};
  for (const [id, n] of Object.entries(c.s ?? {})) { if (n) { s[id] = n; } }
  const f: Record<string, number> = {};
  for (const [id, n] of Object.entries(c.f ?? {})) { if (n) { f[id] = n; } }
  const b: Record<string, number[]> = {};
  for (const [id, arms] of Object.entries(c.b ?? {})) { if ((arms as number[]).some((n) => n)) { b[id] = [...(arms as number[])]; } }
  return { s, b, f };
}

/** sum += sign × c (exact: counters are whole numbers). */
function addCounters(sum: LiveCov, c: FileCov, sign: 1 | -1): void {
  for (const [id, n] of Object.entries(c.s)) { sum.s[id] = (sum.s[id] ?? 0) + sign * n; }
  for (const [id, n] of Object.entries(c.f)) { sum.f[id] = (sum.f[id] ?? 0) + sign * n; }
  for (const [id, arms] of Object.entries(c.b)) {
    const cur = sum.b[id] ?? new Array<number>(arms.length).fill(0);
    sum.b[id] = arms.map((n, i) => (cur[i] ?? 0) + sign * n);
  }
}

const CHANGE_DEBOUNCE_MS = 100;

function _pct(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
}
