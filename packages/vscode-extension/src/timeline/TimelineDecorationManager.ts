/**
 * TimelineDecorationManager.ts — highlights the active step line and renders
 * inline variable values as ghost text in the editor.
 *
 * Uses dedicated TextEditorDecorationTypes separate from DecorationManager.ts.
 * Also registers a HoverProvider that shows variable history + [Add to Watch].
 */
import * as vscode from 'vscode';

/** Serialised VariableSnapshot (plain objects, received from webview postMessage). */
interface VariableSnapshot {
  name: string;
  type: 'primitive' | 'object' | 'array';
  value?: unknown;
  keys?: string[];
}

/** Serialised Step. */
interface Step {
  stepId: number;
  line: number;
  file: string;
  functionName?: string;
}

/** Serialised TimelineStore (Maps become plain objects after JSON.stringify). */
interface SerialisedStore {
  steps: Step[];
  variables: Record<number, VariableSnapshot[]>;
}

export class TimelineDecorationManager {
  // Line highlight (whole-line background + left accent border)
  private readonly _lineHighlight: vscode.TextEditorDecorationType;

  // Inline ghost text (after each variable assignment line)
  private readonly _inlineType: vscode.TextEditorDecorationType;

  // Current state — needed by the hover provider
  private _store: SerialisedStore | null = null;
  private _currentStepId: number | null = null;

  // Hover provider disposable (re-registered when files change)
  private _hoverDisposable: vscode.Disposable | undefined;

  // Callback to forward [Add to Watch] to ExplorerView
  onAddToWatch: ((varName: string) => void) | null = null;

  constructor() {
    this._lineHighlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      borderColor:     new vscode.ThemeColor('focusBorder'),
      borderWidth:     '0 0 0 2px',
      borderStyle:     'solid',
    });

    this._inlineType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 2em',
        color:  new vscode.ThemeColor('editorCodeLens.foreground'),
      },
    });

    this._registerHoverProvider();
  }

  /**
   * Apply the line highlight and inline variable values for the given step.
   * Opens the file if needed.
   */
  async applyStep(
    filePath: string,
    line: number,
    store: SerialisedStore,
    stepId: number,
  ): Promise<void> {
    this._store = store;
    this._currentStepId = stepId;

    if (!filePath || line < 1) { return; }

    const uri = vscode.Uri.file(filePath);
    const pos = new vscode.Position(line - 1, 0);
    const range = new vscode.Range(pos, pos);

    let editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === uri.fsPath,
    );

    if (!editor) {
      const doc = await vscode.workspace.openTextDocument(uri);
      editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: true,
        preview: true,
      });
    }

    this._clearAllDecorations();

    // 1. Line highlight
    editor.setDecorations(this._lineHighlight, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // 2. Inline variable ghost text for the current step
    const vars: VariableSnapshot[] = store.variables[stepId] ?? [];
    if (vars.length > 0) {
      const inlineText = vars
        .map(v => `${v.name} = ${_formatValue(v)}`)
        .join('  ');

      const endOfLine = editor.document.lineAt(line - 1).range.end;
      const inlineRange = new vscode.Range(endOfLine, endOfLine);

      editor.setDecorations(this._inlineType, [{
        range: inlineRange,
        renderOptions: { after: { contentText: `  ${inlineText}` } },
      }]);
    }
  }

  // Back-compat alias used by extension.ts
  async highlight(filePath: string, line: number): Promise<void> {
    if (this._store && this._currentStepId !== null) {
      await this.applyStep(filePath, line, this._store, this._currentStepId);
    } else {
      // No store yet — just highlight without inline values
      if (!filePath || line < 1) { return; }
      const uri = vscode.Uri.file(filePath);
      const pos = new vscode.Position(line - 1, 0);
      const range = new vscode.Range(pos, pos);

      let editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.fsPath === uri.fsPath,
      );
      if (!editor) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
      }
      this._clearAllDecorations();
      editor.setDecorations(this._lineHighlight, [range]);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  clearAll(): void {
    this._store = null;
    this._currentStepId = null;
    this._clearAllDecorations();
  }

  dispose(): void {
    this._lineHighlight.dispose();
    this._inlineType.dispose();
    this._hoverDisposable?.dispose();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _clearAllDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._lineHighlight, []);
      editor.setDecorations(this._inlineType, []);
    }
  }

  private _registerHoverProvider(): void {
    this._hoverDisposable?.dispose();

    this._hoverDisposable = vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover: (document, position) => {
          return this._buildHover(document, position);
        },
      },
    );
  }

  private _buildHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!this._store || this._currentStepId === null) { return; }

    const hoveredLine = position.line + 1; // 1-based

    // Find all steps at this line in this file
    const stepsAtLine = this._store.steps.filter(
      (s) => s.line === hoveredLine && s.file === document.uri.fsPath,
    );
    if (stepsAtLine.length === 0) { return; }

    // Collect all variable values across these steps
    const varHistory: Map<string, { stepId: number; value: VariableSnapshot }[]> = new Map();

    for (const step of stepsAtLine) {
      const vars = this._store.variables[step.stepId] ?? [];
      for (const v of vars) {
        if (!varHistory.has(v.name)) { varHistory.set(v.name, []); }
        varHistory.get(v.name)!.push({ stepId: step.stepId, value: v });
      }
    }

    if (varHistory.size === 0) { return; }

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;

    for (const [name, history] of varHistory) {
      md.appendMarkdown(`**\`${name}\`**\n\n`);

      for (const { stepId, value } of history) {
        const isCurrent = stepId === this._currentStepId;
        const marker = isCurrent ? '→ ' : '  ';
        const val = _formatValue(value);
        md.appendMarkdown(`${marker}step ${stepId}: \`${val}\`\n\n`);
      }

      const addToWatchCmd = `command:liveTestRunner.addToWatch?${encodeURIComponent(JSON.stringify([name]))}`;
      const copyCmd       = `command:liveTestRunner.copyValue?${encodeURIComponent(JSON.stringify([_formatValue(history[history.length - 1].value)]))}`;
      md.appendMarkdown(`[Add to Watch](${addToWatchCmd})  [Copy](${copyCmd})\n\n`);
      md.appendMarkdown('---\n');
    }

    return new vscode.Hover(md);
  }
}

// ── Shared formatting ────────────────────────────────────────────────────────

function _formatValue(snap: VariableSnapshot): string {
  if (snap.type === 'object') { return snap.keys ? `{ ${snap.keys.join(', ')} }` : '{}'; }
  if (snap.type === 'array')  { return snap.keys ? `[${snap.keys.join(', ')}]` : '[]'; }
  if (snap.value === undefined) { return 'undefined'; }
  if (snap.value === null)      { return 'null'; }
  if (typeof snap.value === 'string') { return `"${snap.value}"`; }
  return String(snap.value);
}
