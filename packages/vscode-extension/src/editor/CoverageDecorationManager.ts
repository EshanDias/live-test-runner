import * as vscode from 'vscode';
import * as fs from 'fs';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { CoverageStore } from '../coverage/CoverageStore';
import { Manifest } from '../coverage/types';

/**
 * CoverageDecorationManager — gutter decorations for code coverage.
 *
 * Green heatmap: executed lines (darker = higher hit count).
 * Grey overlay: entire file when entry is 'measured-stale' (file saved, rerun pending).
 *
 * Sole-coverage warnings are stubbed for v2 — decoration type created but never applied.
 */
export class CoverageDecorationManager implements IResultObserver {
  // Green heatmap tiers (low / medium / high hit count)
  private readonly _covLow    = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(0,200,83,0.35)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: this._makeGutterIcon('#00c853', 0.35),
    gutterIconSize: 'contain',
  });
  private readonly _covMid    = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(0,200,83,0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: this._makeGutterIcon('#00c853', 0.6),
    gutterIconSize: 'contain',
  });
  private readonly _covHigh   = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(0,200,83,0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: this._makeGutterIcon('#00c853', 0.9),
    gutterIconSize: 'contain',
  });
  // Grey stale overlay (whole-file)
  private readonly _stale     = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(150,150,150,0.4)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: this._makeGutterIcon('#888888', 0.4),
    gutterIconSize: 'contain',
  });
  // Sole-coverage stub — v2 (created but never applied in v1)
  private readonly _soleCov   = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: 'rgba(255,165,0,0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _store: CoverageStore,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this._refreshAll()),
      this._store.onDidChange.event(() => this._refreshAll()),
    );
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(): void  { this._clearAll(); }
  onSessionStopped(): void  { this._clearAll(); }
  onRunStarted(_p: RunStartedPayload): void { /* no-op */ }
  onFilesRerunning(_ids: string[]): void    { /* no-op */ }
  onFileResult(_fp: string): void           { /* no-op — driven by store.onDidChange */ }
  onRunFinished(_p: RunFinishedPayload): void { /* no-op */ }

  dispose(): void {
    this._clearAll();
    this._covLow.dispose();
    this._covMid.dispose();
    this._covHigh.dispose();
    this._stale.dispose();
    this._soleCov.dispose();
    for (const d of this._disposables) { d.dispose(); }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this._refreshEditor(editor);
    }
  }

  private _clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._covLow,  []);
      editor.setDecorations(this._covMid,  []);
      editor.setDecorations(this._covHigh, []);
      editor.setDecorations(this._stale,   []);
    }
  }

  private _refreshEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const entry = this._store.getEntry(filePath);

    if (!entry) {
      editor.setDecorations(this._covLow,  []);
      editor.setDecorations(this._covMid,  []);
      editor.setDecorations(this._covHigh, []);
      editor.setDecorations(this._stale,   []);
      return;
    }

    if (entry.state === 'counted') {
      // No run data yet — clear decorations
      editor.setDecorations(this._covLow,  []);
      editor.setDecorations(this._covMid,  []);
      editor.setDecorations(this._covHigh, []);
      editor.setDecorations(this._stale,   []);
      return;
    }

    if (entry.state === 'measured-stale') {
      // Whole file grey until rerun completes
      const lineCount = editor.document.lineCount;
      const staleRange = [new vscode.Range(0, 0, lineCount - 1, 0)];
      editor.setDecorations(this._covLow,  []);
      editor.setDecorations(this._covMid,  []);
      editor.setDecorations(this._covHigh, []);
      editor.setDecorations(this._stale,   staleRange);
      return;
    }

    // 'measured' — build heatmap from manifest + counters
    let manifest: Manifest | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(entry.manifestPath, 'utf8')) as Manifest;
    } catch {
      editor.setDecorations(this._covLow,  []);
      editor.setDecorations(this._covMid,  []);
      editor.setDecorations(this._covHigh, []);
      editor.setDecorations(this._stale,   []);
      return;
    }

    // Map line → max hit count across all statements on that line
    const lineHits = new Map<number, number>();
    for (const [id, loc] of Object.entries(manifest.statements)) {
      const hits = entry.counters.s[id] ?? 0;
      if (hits > 0) {
        const line = loc.start.line - 1; // 0-based
        lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
      }
    }

    // Determine heatmap tier thresholds from the data
    const allHits = Array.from(lineHits.values());
    const maxHit  = allHits.length > 0 ? Math.max(...allHits) : 1;
    const midCut  = maxHit * 0.66;
    const lowCut  = maxHit * 0.33;

    const low: vscode.Range[]  = [];
    const mid: vscode.Range[]  = [];
    const high: vscode.Range[] = [];

    for (const [line, hits] of lineHits) {
      const range = new vscode.Range(line, 0, line, 0);
      if (hits >= midCut) {
        high.push(range);
      } else if (hits >= lowCut) {
        mid.push(range);
      } else {
        low.push(range);
      }
    }

    editor.setDecorations(this._covLow,  low);
    editor.setDecorations(this._covMid,  mid);
    editor.setDecorations(this._covHigh, high);
    editor.setDecorations(this._stale,   []);
  }

  private _makeGutterIcon(color: string, opacity: number): vscode.Uri {
    // Inline SVG dot for gutter — written to extension storage so VS Code can load it
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="${color}" fill-opacity="${opacity}"/></svg>`;
    const fileName = `cov-gutter-${color.replace('#', '')}-${Math.round(opacity * 100)}.svg`;
    const uri = vscode.Uri.joinPath(this._context.globalStorageUri, fileName);
    try {
      fs.mkdirSync(this._context.globalStorageUri.fsPath, { recursive: true });
      fs.writeFileSync(uri.fsPath, svg, 'utf8');
    } catch { /* ignore — falls back to no icon */ }
    return uri;
  }
}
