/**
 * ProjectRegistry — the test projects of the window (phase 7, D11/D12).
 *
 * Detects every project (none is run automatically), keeps one
 * {@link ProjectContext} per project, and knows which one is selected: the
 * Explorer, Results panel, gutter / CodeLens and status bar show the
 * selected project; Start / Stop act on it. Other projects keep running in
 * the background. The `liveTestRunner.projectRoot` setting pins the window to
 * that one root (the 3.0 behaviour).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DetectedProject, findTestProjects, isInside, FrameworkDetector } from '@live-test-runner/runner';
import { IResultObserver } from '../IResultObserver';
import { SelectionState } from '../store/SelectionState';
import { logger } from '../utils/logger';
import { ProjectContext, ProjectSummary } from './ProjectContext';
import { resolveMaxRunningProjects, startRefusal } from './projectLimits';

const log = logger.scope('Projects');

const SELECTED_KEY = 'liveTestRunner.selectedProject';

export interface ProjectRegistryDeps {
  /** The window's session folder; projects get sub-folders when there are several. */
  sessionDir: string;
  cacheRootDir: string;
  outputChannel: vscode.OutputChannel;
  observers: IResultObserver[];
  /** Editor features — every project's events (see ProjectContextDeps). */
  editorObservers: Partial<IResultObserver>[];
  selection: SelectionState;
  sendScopedData: (fileId: string, nodeId?: string) => void;
  statusBar: vscode.StatusBarItem;
  /** Remembers the selected project per workspace. */
  memento?: vscode.Memento;
}

/** The project roots for the window: the projectRoot setting, else every detected project. */
export function detectWorkspaceProjects(): { projects: DetectedProject[]; pinned: boolean } {
  const configured = vscode.workspace.getConfiguration('liveTestRunner').get<string>('projectRoot')?.trim();
  if (configured) {
    let framework = 'unknown';
    try { framework = new FrameworkDetector().detectFramework(configured); } catch { /* logged by the detector */ }
    return { projects: [{ root: configured, name: projectName(configured), framework, reason: 'the liveTestRunner.projectRoot setting' }], pinned: true };
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return { projects: findTestProjects(folders), pinned: false };
}

function projectName(dir: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name.trim()) { return name.trim(); }
  } catch { /* no package.json */ }
  return path.basename(dir);
}

export class ProjectRegistry implements vscode.Disposable {
  private _contexts: ProjectContext[] = [];
  private _selected: ProjectContext | undefined;
  private _changeTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly _onDidChangeSelection = new vscode.EventEmitter<ProjectContext | undefined>();
  /** The selected project changed (views must rebind). */
  readonly onDidChangeSelection = this._onDidChangeSelection.event;
  private readonly _onDidChangeProjects = new vscode.EventEmitter<void>();
  /** The list or a project's live state changed (throttled; switcher row). */
  readonly onDidChangeProjects = this._onDidChangeProjects.event;

  constructor(private readonly _deps: ProjectRegistryDeps) {}

  get contexts(): readonly ProjectContext[] { return this._contexts; }
  get selected(): ProjectContext | undefined { return this._selected; }

  /**
   * (Re)detects the projects. Kept when the set of roots is unchanged;
   * otherwise every context is stopped and rebuilt. @returns true when rebuilt.
   */
  refresh(): boolean {
    const { projects, pinned } = detectWorkspaceProjects();
    const same = projects.length === this._contexts.length && projects.every((p, i) => p.root === this._contexts[i].root);
    if (same && this._contexts.length > 0) { return false; }

    for (const c of this._contexts) { c.dispose(); }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this._contexts = projects.map((p, i) => new ProjectContext(p, {
      // One project: the window's session folder itself, exactly as before phase 7.
      sessionDir: projects.length === 1 ? this._deps.sessionDir : path.join(this._deps.sessionDir, `p${i + 1}-${slug(p.name)}`),
      cacheRootDir: this._deps.cacheRootDir,
      outputChannel: this._deps.outputChannel,
      observers: this._deps.observers,
      editorObservers: this._deps.editorObservers,
      selection: this._deps.selection,
      sendScopedData: this._deps.sendScopedData,
      isSelected: (ctx) => ctx === this._selected,
      onStateChanged: () => this._changed(),
      onStatusText: (ctx) => { if (ctx === this._selected) { this.renderStatusBar(); } },
      folder: folders.find((f) => f === p.root || isInside(p.root, f)),
    }));

    if (projects.length === 0) {
      log.info('No test project found — open a folder with a package.json, or run "Live Test Runner: Select Project Root"');
    } else if (projects.length === 1) {
      log.info(`Project root: ${projects[0].root}${pinned ? ' (liveTestRunner.projectRoot)' : ''}`);
    } else {
      log.info(`${projects.length} test projects found (none is run until you start it): ${projects.map((p) => `${p.name} [${p.framework}]`).join(', ')}`);
    }

    const remembered = this._deps.memento?.get<string>(SELECTED_KEY);
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const initial =
      this._contexts.find((c) => c.id === remembered) ??
      (active ? this.forFile(active) : undefined) ??
      this._contexts[0];
    this._selected = undefined;
    this.select(initial);
    return true;
  }

  /** Selects a project (by context or id); views follow via onDidChangeSelection. */
  select(target: ProjectContext | string | undefined): ProjectContext | undefined {
    const ctx = typeof target === 'string' ? this._contexts.find((c) => c.id === target || c.name === target) : target;
    if (!ctx || ctx === this._selected) { return ctx; }
    this._selected = ctx;
    void this._deps.memento?.update(SELECTED_KEY, ctx.id);
    if (this._contexts.length > 1) { log.info(`Showing project "${ctx.name}" (${ctx.root})`); }
    ctx.ensureDiscovery();
    this._onDidChangeSelection.fire(ctx);
    this.renderStatusBar();
    this._changed(true);
    return ctx;
  }

  /** The project a file belongs to (deepest root containing it). */
  forFile(filePath: string): ProjectContext | undefined {
    let best: ProjectContext | undefined;
    for (const c of this._contexts) {
      if (c.root === filePath || isInside(filePath, c.root)) {
        if (!best || c.root.length > best.root.length) { best = c; }
      }
    }
    return best;
  }

  /** Projects with an active session (started, not stopped). */
  running(): ProjectContext[] {
    return this._contexts.filter((c) => c.session.isActive());
  }

  /**
   * Why `ctx` may not start now (D11: liveTestRunner.maxRunningProjects),
   * or undefined. A project already running may always restart.
   */
  startRefusal(ctx: ProjectContext): string | undefined {
    if (ctx.session.isActive()) { return undefined; }
    const setting = vscode.workspace.getConfiguration('liveTestRunner').get<unknown>('maxRunningProjects');
    const limit = resolveMaxRunningProjects(setting);
    return startRefusal(this.running().filter((c) => c !== ctx).map((c) => c.name), limit);
  }

  summaries(): ProjectSummary[] {
    return this._contexts.map((c) => c.summary(c === this._selected));
  }

  /** "Live Tests: ✅ 12 passed" — with several projects: "Live Tests: web · ✅ 12 passed · 2 running". */
  renderStatusBar(): void {
    const sb = this._deps.statusBar;
    const sel = this._selected;
    if (!sel) { sb.text = 'Live Tests: Off'; sb.tooltip = undefined; return; }
    if (this._contexts.length <= 1) {
      sb.text = `Live Tests: ${sel.statusText}`;
      sb.tooltip = undefined;
      return;
    }
    const running = this.running().length;
    sb.text = `Live Tests: ${sel.name} · ${sel.statusText}${running > 0 ? ` · ${running} running` : ''}`;
    sb.tooltip = this._contexts.map((c) => `${c === sel ? '▸ ' : '  '}${c.name}: ${c.runState === 'idle' ? 'off' : c.runState}${c.statusText && c.runState !== 'idle' ? ` — ${c.statusText}` : ''}`).join('\n');
  }

  private _changed(now = false): void {
    if (now) {
      if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = undefined; }
      this._onDidChangeProjects.fire();
      return;
    }
    if (this._changeTimer) { return; }
    this._changeTimer = setTimeout(() => {
      this._changeTimer = undefined;
      this._onDidChangeProjects.fire();
      this.renderStatusBar();
    }, 150);
  }

  dispose(): void {
    if (this._changeTimer) { clearTimeout(this._changeTimer); }
    for (const c of this._contexts) { c.dispose(); }
    this._contexts = [];
    this._onDidChangeSelection.dispose();
    this._onDidChangeProjects.dispose();
  }
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}
