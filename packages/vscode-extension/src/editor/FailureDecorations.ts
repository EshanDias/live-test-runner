import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileStoresResolver } from './FileStores';
import { IResultObserver } from '../IResultObserver';
import type { ResultStore, TestNode } from '../store/ResultStore';
import { FailureFrame, ParsedFailure, parseFailure } from './failureInfo';

/** One failure shown on one line. */
export interface FailureMark {
  nodeId: string;
  testFile: string;
  testName: string;
  failure: ParsedFailure;
  /** 1-based. */
  line: number;
}

const SCHEME = 'ltr-failure';
const SETTING = 'showFailuresInEditor';
const MAX_HOVER_LINES = 40;

/**
 * A failed test's message on the line where it failed: the assertion in the
 * test, and the line of a source file the error was thrown from. The hover
 * holds the whole message with Show diff (expected / received side by side),
 * Open in Results and Dismiss.
 *
 * A line edited since the run shows nothing: the message may no longer be
 * about it. Dismiss hides a test's message until the test runs again.
 */
export class FailureDecorations implements Partial<IResultObserver>, vscode.HoverProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorError.foreground'), margin: '0 0 0 2em', fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  /** The line's text when its mark was first drawn, by `nodeId:file:line`. */
  private readonly _lineText = new Map<string, string>();
  private readonly _dismissed = new Set<string>();
  /** Expected / received texts served to the diff editor, by `nodeId`. */
  private readonly _sides = new Map<string, { expected: string; actual: string }>();
  private readonly _parsed = new WeakMap<TestNode, { messages: string[]; failure: ParsedFailure }>();
  private readonly _disposables: vscode.Disposable[] = [];
  private _redrawTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly _resolve: FileStoresResolver) {
    this._disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) { return; }
        clearTimeout(this._redrawTimer);
        this._redrawTimer = setTimeout(() => this.refresh(), 150);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`liveTestRunner.${SETTING}`)) { this.refresh(); }
      }),
      vscode.commands.registerCommand('liveTestRunner.dismissFailure', (nodeId: string) => {
        this._dismissed.add(nodeId);
        this.refresh();
      }),
      vscode.commands.registerCommand('liveTestRunner.showFailureDiff', async (nodeId: string, title?: string) => {
        if (!this._sides.has(nodeId)) { return; }
        const id = encodeURIComponent(nodeId);
        await vscode.commands.executeCommand('vscode.diff',
          vscode.Uri.from({ scheme: SCHEME, path: `/Expected`, query: id }),
          vscode.Uri.from({ scheme: SCHEME, path: `/Received`, query: id }),
          `${title ?? 'Test'}: expected ↔ received`);
      }),
    );
  }

  // ── IResultObserver ────────────────────────────────────────────────────────

  onSessionStarted(): void { this.refresh(); }
  onSessionStopped(): void { this.refresh(); }
  onRunFinished(): void { this.refresh(); }
  onFileResult(): void { this.refresh(); }

  /** A test that runs again shows its new result, even if its old one was dismissed. */
  onFilesRerunning(fileIds: string[]): void {
    for (const fileId of fileIds) {
      const store = this._resolve(fileId)?.store;
      for (const n of store?.getFileNodes(fileId) ?? []) { this._dismissed.delete(n.id); }
    }
    this.refresh();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) { this.applyToEditor(editor); }
  }

  applyToEditor(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') { return; }
    const marks = this.marks(editor.document);
    editor.setDecorations(this._decoration, marks.map((m) => {
      const end = editor.document.lineAt(m.line - 1).range.end;
      return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: `✗ ${m.failure.summary}` } } };
    }));
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const marks = this.marks(document).filter((m) => m.line - 1 === position.line);
    if (marks.length === 0) { return undefined; }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['liveTestRunner.showFailureDiff', 'liveTestRunner.dismissFailure', 'liveTestRunner.focusResult', 'liveTestRunner.updateSnapshot'] };
    marks.forEach((m, i) => {
      if (i > 0) { md.appendMarkdown('\n\n---\n\n'); }
      md.appendMarkdown(`$(error) **${escapeMd(m.testName)}** failed\n\n`);
      const lines = m.failure.message.split('\n');
      const shown = lines.length > MAX_HOVER_LINES ? [...lines.slice(0, MAX_HOVER_LINES), '…'] : lines;
      md.appendCodeblock(shown.join('\n'), 'text');
      const cmd = (name: string, args: unknown[]) => `command:${name}?${encodeURIComponent(JSON.stringify(args))}`;
      const links: string[] = [];
      if (m.failure.expected !== undefined && m.failure.actual !== undefined) {
        this._sides.set(m.nodeId, { expected: m.failure.expected, actual: m.failure.actual });
        links.push(`[Show diff](${cmd('liveTestRunner.showFailureDiff', [m.nodeId, m.testName])} "Expected and received side by side")`);
      }
      // Snapshots of Jest / Vitest tests (pytest snapshot plugins are not supported).
      if (m.failure.snapshot && !/\.py$/i.test(m.testFile)) {
        links.push(`[Update snapshot](${cmd('liveTestRunner.updateSnapshot', [m.testFile, m.nodeId])} "Asks first, then the test framework rewrites this test's snapshot")`);
      }
      links.push(`[Open in Results](${cmd('liveTestRunner.focusResult', [m.testFile, m.nodeId])})`);
      links.push(`[Dismiss](${cmd('liveTestRunner.dismissFailure', [m.nodeId])} "Hide until this test runs again")`);
      md.appendMarkdown(links.join(' · '));
    });
    return new vscode.Hover(md);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const sides = this._sides.get(decodeURIComponent(uri.query));
    if (!sides) { return ''; }
    return uri.path === '/Expected' ? sides.expected : sides.actual;
  }

  dispose(): void {
    clearTimeout(this._redrawTimer);
    this._decoration.dispose();
    for (const d of this._disposables) { d.dispose(); }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** What is shown in this document (none when the setting is off). */
  marks(document: vscode.TextDocument): FailureMark[] {
    return this._enabled() ? this._marksFor(document) : [];
  }

  private _enabled(): boolean {
    return vscode.workspace.getConfiguration('liveTestRunner').get<boolean>(SETTING, true);
  }

  /** The failures to show in this document: from every failed test of its project. */
  private _marksFor(document: vscode.TextDocument): FailureMark[] {
    const filePath = document.uri.fsPath;
    const store = this._resolve(filePath)?.store;
    if (!store) { return []; }
    const marks: FailureMark[] = [];
    for (const { node, testFile, failure } of this._failedTests(store)) {
      if (this._dismissed.has(node.id)) { continue; }
      for (const line of linesIn(failure.frames, testFile, filePath)) {
        if (line > document.lineCount) { continue; }
        // A line edited since the run shows nothing (the message may not be about it any more).
        const key = `${node.id}\0${filePath}\0${line}`;
        const text = document.lineAt(line - 1).text;
        const seen = this._lineText.get(key);
        if (seen === undefined) { this._lineText.set(key, text); }
        else if (seen !== text) { continue; }
        marks.push({ nodeId: node.id, testFile, testName: node.fullName, failure, line });
      }
    }
    return marks;
  }

  private *_failedTests(store: ResultStore): Generator<{ node: TestNode; testFile: string; failure: ParsedFailure }> {
    for (const file of store.getAllFiles()) {
      if (file.status !== 'failed') { continue; }
      for (const node of store.getFileNodes(file.fileId)) {
        if (node.type !== 'test' || node.status !== 'failed' || node.failureMessages.length === 0) { continue; }
        let cached = this._parsed.get(node);
        if (!cached || cached.messages !== node.failureMessages) {
          cached = { messages: node.failureMessages, failure: parseFailure(node.failureMessages[0]) };
          this._parsed.set(node, cached);
          // A new result: forget the line texts of the old one.
          for (const k of this._lineText.keys()) { if (k.startsWith(`${node.id}\0`)) { this._lineText.delete(k); } }
        }
        yield { node, testFile: file.fileId, failure: cached.failure };
      }
    }
  }
}

/**
 * The lines of `filePath` to mark for one failure: where it was thrown (the
 * innermost frame in the project), and the line of the test that led there.
 */
export function linesIn(frames: FailureFrame[], testFile: string, filePath: string): number[] {
  const resolved = frames.map((f) => ({ file: resolveFrameFile(f.file, testFile), line: f.line }));
  const picked = [resolved[0], resolved.find((f) => samePath(f.file, testFile))].filter((f): f is { file: string; line: number } => !!f);
  return [...new Set(picked.filter((f) => samePath(f.file, filePath)).map((f) => f.line))];
}

/** An absolute path as is; a relative one (Vitest, pytest) from the folder above the test file that has it. */
export function resolveFrameFile(file: string, testFile: string): string {
  if (path.isAbsolute(file)) { return file; }
  let dir = path.dirname(testFile);
  for (;;) {
    const candidate = path.join(dir, file);
    if (samePath(candidate, testFile) || fs.existsSync(candidate)) { return candidate; }
    const up = path.dirname(dir);
    if (up === dir) { return path.join(path.dirname(testFile), file); }
    dir = up;
  }
}

/** Real paths, cached: a framework may print `/private/var/…` for a file VS Code opened as `/var/…`. */
const realCache = new Map<string, string>();
export function realPath(p: string): string {
  let r = realCache.get(p);
  if (r === undefined) {
    try { r = fs.realpathSync.native(p); } catch { r = p; }
    if (realCache.size > 5000) { realCache.clear(); }
    realCache.set(p, r);
  }
  return r;
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.normalize(realPath(p)).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
