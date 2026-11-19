import * as vscode from 'vscode';
import * as fs from 'fs';
import { IResultObserver, RunStartedPayload, RunFinishedPayload } from '../IResultObserver';
import { CoverageStore } from '../coverage/CoverageStore';
import { FileStoresResolver } from './FileStores';
import { Manifest, LiveCov } from '../coverage/types';
import { lineStates } from '../coverage/lineStates';
import { LineMapping, MeasuredLines } from './MeasuredLines';

/** Setting that shows or hides coverage in the editor (bars, stale tint, hover). */
export const SHOW_COVERAGE_SETTING = 'showCoverageInEditor';
/** Context key: the active editor's file has coverage to show or hide. */
const HAS_COVERAGE_CONTEXT = 'liveTestRunner.editorHasCoverage';
/** Context key: coverage is shown in the editor (picks the Show / Hide button). */
const SHOWN_CONTEXT = 'liveTestRunner.coverageInEditorShown';

/** Redraw delay after typing — long enough to skip most keystrokes, short enough to feel live. */
const EDIT_REDRAW_MS = 150;

/** Lines (0-based, current editor lines) each kind of bar was last drawn on — for the e2e tests. */
export interface DrawnCoverage {
  covered: number[];
  partial: number[];
  uncovered: number[];
}

export class CoverageDecorationManager implements IResultObserver {
  private readonly _covered:   vscode.TextEditorDecorationType;
  private readonly _partial:   vscode.TextEditorDecorationType;
  private readonly _uncovered: vscode.TextEditorDecorationType;
  private readonly _stale:     vscode.TextEditorDecorationType;
  // Sole-coverage stub — T3 (created but never applied)
  private readonly _soleCov:   vscode.TextEditorDecorationType;

  private readonly _disposables: vscode.Disposable[] = [];
  private _storeSubs: vscode.Disposable[] = [];
  private readonly _editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _drawn = new Map<string, DrawnCoverage>();
  private _shown = true;

  /** Every file shows its own project's coverage. */
  constructor(
    private readonly _resolve: FileStoresResolver,
    /** Shared with the hover, so both follow the user's unsaved edits the same way. */
    readonly measuredLines: MeasuredLines = new MeasuredLines(),
  ) {
    // A thin, faded coloured left edge on each executable line (1px whole-line border):
    // nothing is inserted into the text, so code does not shift and the
    // gutter stays free for breakpoints and test status icons.
    // overviewRulerColor mirrors state in the scrollbar.
    // The bar covers the middle of the line only (border-image gradient), so
    // neighbouring lines read as separate marks instead of one long line.
    const bar = (color: string, ruler: string): vscode.DecorationRenderOptions => ({
      isWholeLine:       true,
      borderStyle:       'solid',
      borderColor:       `${color}; border-image: linear-gradient(to bottom, transparent 18%, ${color} 18%, ${color} 82%, transparent 82%) 1`,
      borderWidth:       '0 0 0 1px',
      overviewRulerColor: ruler,
      overviewRulerLane:  vscode.OverviewRulerLane.Left,
    });
    this._covered   = vscode.window.createTextEditorDecorationType(bar('rgba(34,197,94,0.55)', 'rgba(34,197,94,0.7)'));
    this._partial   = vscode.window.createTextEditorDecorationType(bar('rgba(245,158,11,0.7)', 'rgba(245,158,11,0.7)'));
    this._uncovered = vscode.window.createTextEditorDecorationType(bar('rgba(239,68,68,0.7)', 'rgba(239,68,68,0.6)'));
    this._stale = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(128,128,128,0.07)',
      isWholeLine: true,
    });
    this._soleCov = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: 'rgba(251,146,60,0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    this._shown = readShown();
    void vscode.commands.executeCommand('setContext', SHOWN_CONTEXT, this._shown);

    this._disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this._refreshAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this._refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this._onEdit(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.measuredLines.forget(doc.uri.fsPath)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(`liveTestRunner.${SHOW_COVERAGE_SETTING}`)) { return; }
        this._shown = readShown();
        void vscode.commands.executeCommand('setContext', SHOWN_CONTEXT, this._shown);
        this._refreshAll();
      }),
    );
  }

  /** Whether coverage is shown in the editor (`liveTestRunner.showCoverageInEditor`). */
  get shown(): boolean { return this._shown; }

  /** Shows or hides coverage in the editor; remembered in the user settings. */
  async setShown(shown: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('liveTestRunner')
      .update(SHOW_COVERAGE_SETTING, shown, vscode.ConfigurationTarget.Global);
  }

  /** The lines each kind of bar was last drawn on in `filePath`'s editor (e2e tests). */
  drawnLines(filePath: string): DrawnCoverage | undefined {
    return this._drawn.get(filePath);
  }

  /** Redraws on changes of any of these stores (every project's; replaced when projects are re-detected). */
  watch(stores: CoverageStore[]): void {
    for (const d of this._storeSubs) { d.dispose(); }
    this._storeSubs = stores.map((s) => s.onDidChange.event(() => this._refreshAll()));
    this._refreshAll();
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  // Session changes clear that project's store, which redraws through watch().
  onSessionStarted(): void                      { /* driven by store.onDidChange */ }
  onSessionStopped(): void                      { /* driven by store.onDidChange */ }
  onRunStarted(_p: RunStartedPayload): void     { /* driven by store.onDidChange */ }
  onFilesRerunning(_ids: string[]): void        { /* driven by store.onDidChange */ }
  onFileResult(_fp: string): void               { /* driven by store.onDidChange */ }
  onRunFinished(_p: RunFinishedPayload): void   { /* driven by store.onDidChange */ }

  dispose(): void {
    this._clearAll();
    this._covered.dispose();
    this._partial.dispose();
    this._uncovered.dispose();
    this._stale.dispose();
    this._soleCov.dispose();
    for (const t of this._editTimers.values()) { clearTimeout(t); }
    for (const d of this._disposables) { d.dispose(); }
    for (const d of this._storeSubs) { d.dispose(); }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Typing: redraw that document's editors shortly after (bars follow moved lines, leave edited ones). */
  private _onEdit(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const pending = this._editTimers.get(key);
    if (pending) { clearTimeout(pending); }
    this._editTimers.set(key, setTimeout(() => {
      this._editTimers.delete(key);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === doc) { this._refreshEditor(editor); }
      }
    }, EDIT_REDRAW_MS));
  }

  private _refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this._refreshEditor(editor);
    }
    const active = vscode.window.activeTextEditor;
    const entry = active ? this._resolve(active.document.uri.fsPath)?.coverageStore.getEntry(active.document.uri.fsPath) : undefined;
    void vscode.commands.executeCommand('setContext', HAS_COVERAGE_CONTEXT, !!entry && entry.state !== 'counted');
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
    editor.setDecorations(this._stale,     []);
    this._drawn.delete(editor.document.uri.fsPath);
  }

  private _refreshEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const entry = this._resolve(filePath)?.coverageStore.getEntry(filePath);

    if (!this._shown || !entry || entry.state === 'counted') {
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

    const lines = this.measuredLines.mappingFor(editor.document, entry.counters);
    const drawn = this._classifyLines(manifest, entry.counters, lines, editor.document.lineCount);
    const ranges = (list: number[]) => list.map((l) => new vscode.Range(l, 0, l, 0));
    editor.setDecorations(this._covered,   ranges(drawn.covered));
    editor.setDecorations(this._partial,   ranges(drawn.partial));
    editor.setDecorations(this._uncovered, ranges(drawn.uncovered));
    this._drawn.set(filePath, drawn);

    // Stale tint — grey background over full file; bars remain visible underneath
    if (entry.state === 'measured-stale') {
      const full = [new vscode.Range(0, 0, editor.document.lineCount - 1, 0)];
      editor.setDecorations(this._stale, full);
    } else {
      editor.setDecorations(this._stale, []);
    }
  }

  /** Each executable measured line's bar, moved to where that line is now (edited lines get none). */
  private _classifyLines(manifest: Manifest, counters: LiveCov, lines: LineMapping, lineCount: number): DrawnCoverage {
    const drawn: DrawnCoverage = { covered: [], partial: [], uncovered: [] };
    for (const [line1, state] of lineStates(manifest, counters)) {
      const now = lines.toCurrent(line1 - 1);
      if (now < 0 || now >= lineCount) { continue; }
      drawn[state].push(now);
    }
    return drawn;
  }
}

function readShown(): boolean {
  return vscode.workspace.getConfiguration('liveTestRunner').get<boolean>(SHOW_COVERAGE_SETTING, true);
}
