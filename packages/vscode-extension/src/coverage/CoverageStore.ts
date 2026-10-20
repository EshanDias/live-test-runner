import * as vscode from 'vscode';
import { CoverageEntry, CoveragePct, CoverageTotals, LiveCov } from './types';
import { logger } from '../utils/logger';

const log = logger.scope('Coverage');

export class CoverageStore {
  private readonly _entries = new Map<string, CoverageEntry>();
  private _scanComplete = false;

  readonly onDidChange = new vscode.EventEmitter<void>();
  private _fireTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Writes ──────────────────────────────────────────────────────────────────

  /**
   * Static count from the source scan (0 hits). The scan runs alongside the
   * first test run, so a file may already be measured — never downgrade it
   * back to 0% (BUG-09).
   */
  setCountedEntry(
    filePath: string,
    counts: { statements: number; branches: number; functions: number; lines: number },
  ): void {
    const existing = this._entries.get(filePath);
    if (existing && existing.state !== 'counted') { return; }
    this._entries.set(filePath, { state: 'counted', ...counts });
    this._changed();
  }

  setMeasuredEntry(
    filePath: string,
    data: { manifestPath: string; counters: LiveCov; pct: CoveragePct },
  ): void {
    this._entries.set(filePath, { state: 'measured', ...data });
    log.trace(
      `${filePath}: stmts ${data.pct.statements.covered}/${data.pct.statements.total}, ` +
      `branches ${data.pct.branches.covered}/${data.pct.branches.total}, ` +
      `fns ${data.pct.functions.covered}/${data.pct.functions.total}, ` +
      `lines ${data.pct.lines.covered}/${data.pct.lines.total}`,
    );
    this._changed();
  }

  markFileStale(filePath: string): void {
    const entry = this._entries.get(filePath);
    if (entry?.state === 'measured') {
      this._entries.set(filePath, { ...entry, state: 'measured-stale' });
      log.trace(`Marked stale: ${filePath}`);
      this._changed();
    }
  }

  clearStale(filePath: string): void {
    const entry = this._entries.get(filePath);
    if (entry?.state === 'measured-stale') {
      this._entries.set(filePath, { ...entry, state: 'measured' });
      log.trace(`Cleared stale flag: ${filePath}`);
      this._changed();
    }
  }

  markScanComplete(): void {
    this._scanComplete = true;
    this._changed();
  }

  clear(): void {
    this._entries.clear();
    this._scanComplete = false;
    if (this._fireTimer) { clearTimeout(this._fireTimer); this._fireTimer = undefined; }
    this.onDidChange.fire();
  }

  /**
   * Coalesces change events: every fire re-sends all coverage rows to the
   * webview, and the source scan writes one entry per file — firing per entry
   * was O(N²) traffic on large repos (BUG-09).
   */
  private _changed(): void {
    if (this._fireTimer) { return; }
    this._fireTimer = setTimeout(() => {
      this._fireTimer = undefined;
      this.onDidChange.fire();
    }, CHANGE_DEBOUNCE_MS);
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  getEntry(filePath: string): CoverageEntry | undefined {
    return this._entries.get(filePath);
  }

  getAllEntries(): IterableIterator<[string, CoverageEntry]> {
    return this._entries.entries();
  }

  isScanComplete(): boolean {
    return this._scanComplete;
  }

  isAllMeasured(): boolean {
    for (const entry of this._entries.values()) {
      if (entry.state === 'counted') { return false; }
    }
    return true;
  }

  getTotals(): CoverageTotals {
    let stmtsCovered = 0, stmtsTotal = 0;
    let branchCovered = 0, branchTotal = 0;
    let fnsCovered = 0, fnsTotal = 0;
    let linesCovered = 0, linesTotal = 0;

    for (const entry of this._entries.values()) {
      if (entry.state === 'counted') {
        stmtsTotal  += entry.statements;
        branchTotal += entry.branches;
        fnsTotal    += entry.functions;
        linesTotal  += entry.lines;
      } else {
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
    };
  }

  getFileRows(): Array<{ filePath: string; state: string; pct: CoveragePct }> {
    const rows: Array<{ filePath: string; state: string; pct: CoveragePct }> = [];
    for (const [filePath, entry] of this._entries) {
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
}

const CHANGE_DEBOUNCE_MS = 100;

function _pct(covered: number, total: number): number {
  return total === 0 ? 0 : Math.round((covered / total) * 1000) / 10;
}
