import * as vscode from 'vscode';
import { CoverageEntry, CoveragePct, CoverageTotals, LiveCov } from './types';

export class CoverageStore {
  private readonly _entries = new Map<string, CoverageEntry>();
  private _scanComplete = false;

  readonly onDidChange = new vscode.EventEmitter<void>();

  // ── Writes ──────────────────────────────────────────────────────────────────

  setCountedEntry(
    filePath: string,
    counts: { statements: number; branches: number; functions: number; lines: number },
  ): void {
    this._entries.set(filePath, { state: 'counted', ...counts });
    this.onDidChange.fire();
  }

  setMeasuredEntry(
    filePath: string,
    data: { manifestPath: string; counters: LiveCov; pct: CoveragePct },
  ): void {
    this._entries.set(filePath, { state: 'measured', ...data });
    this.onDidChange.fire();
  }

  markFileStale(filePath: string): void {
    const entry = this._entries.get(filePath);
    if (entry?.state === 'measured') {
      this._entries.set(filePath, { ...entry, state: 'measured-stale' });
      this.onDidChange.fire();
    }
  }

  clearStale(filePath: string): void {
    const entry = this._entries.get(filePath);
    if (entry?.state === 'measured-stale') {
      this._entries.set(filePath, { ...entry, state: 'measured' });
      this.onDidChange.fire();
    }
  }

  markScanComplete(): void {
    this._scanComplete = true;
    this.onDidChange.fire();
  }

  clear(): void {
    this._entries.clear();
    this._scanComplete = false;
    this.onDidChange.fire();
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
      }
    }
    return rows;
  }

  dispose(): void {
    this.onDidChange.dispose();
  }
}

function _pct(covered: number, total: number): number {
  return total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;
}
