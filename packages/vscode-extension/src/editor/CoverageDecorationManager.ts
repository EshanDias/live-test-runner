import * as vscode from 'vscode';
import * as fs from 'fs';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { CoverageStore } from '../coverage/CoverageStore';
import { Manifest, LiveCov } from '../coverage/types';

export class CoverageDecorationManager implements IResultObserver {
  private readonly _covered:   vscode.TextEditorDecorationType;
  private readonly _partial:   vscode.TextEditorDecorationType;
  private readonly _uncovered: vscode.TextEditorDecorationType;
  private readonly _neutral:   vscode.TextEditorDecorationType;
  private readonly _stale:     vscode.TextEditorDecorationType;
  // Sole-coverage stub — T3 (created but never applied)
  private readonly _soleCov:   vscode.TextEditorDecorationType;

  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _store: CoverageStore,
  ) {
    // ▌ before pseudo-element — thin coloured bar at start of text content.
    // Applied to all executable lines so the shift is uniform (no misalignment).
    // Never touches the gutter, so breakpoints work on every line.
    // overviewRulerColor mirrors state in the scrollbar minimap.
    this._covered   = vscode.window.createTextEditorDecorationType({
      before:             { contentText: '▌', color: '#22c55e', margin: '0 3px 0 0' },
      overviewRulerColor: 'rgba(34,197,94,0.7)',
      overviewRulerLane:  vscode.OverviewRulerLane.Left,
    });
    this._partial   = vscode.window.createTextEditorDecorationType({
      before:             { contentText: '▌', color: '#f59e0b', margin: '0 3px 0 0' },
      overviewRulerColor: 'rgba(245,158,11,0.7)',
      overviewRulerLane:  vscode.OverviewRulerLane.Left,
    });
    this._uncovered = vscode.window.createTextEditorDecorationType({
      before:             { contentText: '▌', color: '#ef4444', margin: '0 3px 0 0' },
      overviewRulerColor: 'rgba(239,68,68,0.6)',
      overviewRulerLane:  vscode.OverviewRulerLane.Left,
    });
    this._neutral   = vscode.window.createTextEditorDecorationType({
      before:             { contentText: '▌', color: 'rgba(128,128,128,0.25)', margin: '0 3px 0 0' },
    });
    this._stale = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(128,128,128,0.07)',
      isWholeLine: true,
    });
    this._soleCov = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(251,146,60,0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this._disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this._refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this._refreshAll()),
      this._store.onDidChange.event(() => this._refreshAll()),
    );
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(): void                      { this._clearAll(); }
  onSessionStopped(): void                      { this._clearAll(); }
  onRunStarted(_p: RunStartedPayload): void     { /* driven by store.onDidChange */ }
  onFilesRerunning(_ids: string[]): void        { /* driven by store.onDidChange */ }
  onFileResult(_fp: string): void               { /* driven by store.onDidChange */ }
  onRunFinished(_p: RunFinishedPayload): void   { /* driven by store.onDidChange */ }

  dispose(): void {
    this._clearAll();
    this._covered.dispose();
    this._partial.dispose();
    this._uncovered.dispose();
    this._neutral.dispose();
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
      this._clearEditor(editor);
    }
  }

  private _clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this._covered,   []);
    editor.setDecorations(this._partial,   []);
    editor.setDecorations(this._uncovered, []);
    editor.setDecorations(this._neutral,   []);
    editor.setDecorations(this._stale,     []);
  }

  private _refreshEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const entry = this._store.getEntry(filePath);

    if (!entry || entry.state === 'counted') {
      this._clearEditor(editor);
      return;
    }

    let manifest: Manifest | undefined;
    try {
      manifest = JSON.parse(fs.readFileSync(entry.manifestPath, 'utf8')) as Manifest;
    } catch {
      this._clearEditor(editor);
      return;
    }

    const { covered, partial, uncovered, neutral } = this._classifyLines(manifest, entry.counters, editor.document.lineCount);
    editor.setDecorations(this._covered,   covered);
    editor.setDecorations(this._partial,   partial);
    editor.setDecorations(this._uncovered, uncovered);
    editor.setDecorations(this._neutral,   neutral);

    // Stale tint — grey background over full file; bars remain visible underneath
    if (entry.state === 'measured-stale') {
      const full = [new vscode.Range(0, 0, editor.document.lineCount - 1, 0)];
      editor.setDecorations(this._stale, full);
    } else {
      editor.setDecorations(this._stale, []);
    }
  }

  private _classifyLines(manifest: Manifest, counters: LiveCov, lineCount: number): {
    covered:   vscode.Range[];
    partial:   vscode.Range[];
    uncovered: vscode.Range[];
    neutral:   vscode.Range[];
  } {
    // Line → max statement hit count across all statements on that line
    const lineHits = new Map<number, number>();
    for (const [id, loc] of Object.entries(manifest.statements)) {
      const hits = counters.s[id] ?? 0;
      const line = loc.start.line - 1; // 0-based
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }

    // Line → { total branch arms, covered arms } — only for lines that have branches
    const lineBranches = new Map<number, { total: number; covered: number }>();
    for (const [id, branch] of Object.entries(manifest.branches)) {
      const arms    = counters.b[id] ?? [];
      const covArms = arms.filter((n) => n > 0).length;
      const line    = branch.line - 1; // 0-based
      const existing = lineBranches.get(line) ?? { total: 0, covered: 0 };
      lineBranches.set(line, {
        total:   existing.total   + branch.arms,
        covered: existing.covered + covArms,
      });
    }

    const covered:   vscode.Range[] = [];
    const partial:   vscode.Range[] = [];
    const uncovered: vscode.Range[] = [];
    const executableLines = new Set<number>();

    for (const [line, hits] of lineHits) {
      const range = new vscode.Range(line, 0, line, 0);
      executableLines.add(line);
      if (hits === 0) {
        uncovered.push(range);
      } else {
        const branches = lineBranches.get(line);
        if (branches && branches.covered < branches.total) {
          partial.push(range);
        } else {
          covered.push(range);
        }
      }
    }

    const neutral: vscode.Range[] = [];
    for (let i = 0; i < lineCount; i++) {
      if (!executableLines.has(i)) {
        neutral.push(new vscode.Range(i, 0, i, 0));
      }
    }

    return { covered, partial, uncovered, neutral };
  }
}
