/**
 * ProjectContext — one test project of the workspace (phase 7, D11) with
 * everything that used to exist once per window: its result / trace /
 * coverage stores, discovery (+ cache), framework services, session dir and
 * its own SessionManager.
 *
 * Results still flow one way (CLAUDE.md §1): the project's SessionManager
 * notifies the project's {@link ProjectObserverGate}, which records the
 * project's live state (for the switcher row) and forwards every event to
 * the window's views (Explorer, Results) only while the project is the
 * selected one; editor features (gutter, CodeLens, coverage bars) hear every
 * project, since each file is decorated from its own project. A background project keeps running; switching to it rebinds
 * the views to its stores (see ProjectRegistry).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DetectedProject, FrameworkId, FRAMEWORK_IDS } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { SelectionState } from '../store/SelectionState';
import { CoverageStore } from '../coverage/CoverageStore';
import { TestDiscoveryService, DiscoveryCallbacks } from '../session/TestDiscoveryService';
import { SessionManager } from '../session/SessionManager';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { FrameworkRouter } from '../framework/FrameworkRouter';
import { createJestServices } from '../framework/jestServices';
import { createVitestServices } from '../framework/vitestServices';
import { createPytestServices } from '../framework/pytestServices';
import { IFrameworkServicesProvider, SingleFrameworkProvider } from '../framework/FrameworkServices';
import { TestFileDiscoverer, jsDiscoverer } from '../session/discovery/TestFileDiscoverer';
import { pythonDiscoverer } from '../session/discovery/pythonDiscovery';
import { IResultObserver, RunStartedPayload, RunFinishedPayload, CoverageFileRow } from '../IResultObserver';
import { CoverageTotals } from '../coverage/types';
import { logger } from '../utils/logger';

const log = logger.scope('Projects');

/** What the switcher row shows for a project. */
export type ProjectRunState = 'idle' | 'discovering' | 'running' | 'watching';

/** One row of the project switcher (posted to the Explorer webview). */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Root relative to its workspace folder ('' = the folder itself). */
  relPath: string;
  framework: FrameworkId;
  state: ProjectRunState;
  total: number;
  passed: number;
  failed: number;
  /** Files finished / scheduled while running. */
  progress?: { completed: number; total: number };
  selected: boolean;
}

/** The view state of a project — what views need to show it after a switch. */
export interface ProjectViewState {
  store: ResultStore;
  coverageStore: CoverageStore;
  traceStore: ExecutionTraceStore;
  sessionActive: boolean;
  isDiscovering: boolean;
  discoveryTotal: number;
  discoveryDone: number;
  /** Set while a run is in flight. */
  running?: { completed: number; total: number; failed: number };
}

export interface ProjectContextDeps {
  /** This project's own temp folder (configs, results, traces, coverage). */
  sessionDir: string;
  /** Shared folder for the per-project discovery caches. */
  cacheRootDir: string;
  outputChannel: vscode.OutputChannel;
  /** The window's observers (Explorer, Results panel) — receive events only while this project is selected. */
  observers: IResultObserver[];
  /**
   * Editor features (gutter, CodeLens, coverage bars) — receive every
   * project's events: each file is decorated from its own project.
   */
  editorObservers: Partial<IResultObserver>[];
  selection: SelectionState;
  /** Refreshes the Results view's scoped logs (only called for the selected project). */
  sendScopedData: (fileId: string, nodeId?: string) => void;
  isSelected: (ctx: ProjectContext) => boolean;
  /** The project's state changed (switcher row, status bar). */
  onStateChanged: (ctx: ProjectContext) => void;
  /** The project's status text changed. */
  onStatusText: (ctx: ProjectContext) => void;
  /** Workspace folder the project belongs to (for its relative path). */
  folder?: string;
}

export class ProjectContext implements vscode.Disposable {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly framework: FrameworkId;
  readonly relPath: string;
  readonly sessionDir: string;
  readonly traceDir: string;

  readonly store = new ResultStore();
  readonly traceStore = new ExecutionTraceStore();
  readonly coverageStore = new CoverageStore();
  readonly discovery = new TestDiscoveryService();
  /** Which framework runs each file (one, or Jest + Vitest in a mixed project — phase 8; pytest projects: pytest). */
  readonly services: IFrameworkServicesProvider;
  /** How the project's test files are found statically (Babel for JS, the line scanner for pytest). */
  readonly discoverer: TestFileDiscoverer;
  readonly session: SessionManager;
  readonly gate: ProjectObserverGate;
  discoveryCache: DiscoveryCache | undefined;

  /** Status text without the "Live Tests: " prefix. */
  statusText = 'Off';
  private _discoveryStarted = false;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(project: DetectedProject, private readonly _deps: ProjectContextDeps) {
    this.id = project.root;
    this.root = project.root;
    this.name = project.name;
    this.framework = project.framework;
    this.relPath = _deps.folder ? path.relative(_deps.folder, project.root).split(path.sep).join('/') : '';
    this.sessionDir = _deps.sessionDir;
    this.traceDir = path.join(_deps.sessionDir, 'traces');
    try { fs.mkdirSync(this.sessionDir, { recursive: true }); } catch (err) {
      log.error(`Could not create the session folder ${this.sessionDir} for "${this.name}" — its runs will fail`, err);
    }

    const rawLog = (msg: string) => _deps.outputChannel.appendLine(msg);
    if (project.framework === FRAMEWORK_IDS.pytest) {
      // A Python project: pytest for every file (JS + Python in one folder is a later release, D13).
      this.services = new SingleFrameworkProvider(createPytestServices({ sessionDir: this.sessionDir, coverageStore: this.coverageStore, rawLog }));
      this.discoverer = pythonDiscoverer();
    } else {
      this.services = new FrameworkRouter(
        {
          jest: () => createJestServices({ sessionDir: this.sessionDir, coverageStore: this.coverageStore, rawLog }),
          vitest: () => createVitestServices({ sessionDir: this.sessionDir, coverageStore: this.coverageStore, rawLog }),
        },
        this.root,
      );
      this.discoverer = jsDiscoverer;
    }
    // Mixed by its configs is known now (switcher label); the setting and listing refine it at Start.
    this.services.prepare(this.root);
    this.gate = new ProjectObserverGate(this, _deps.observers, _deps.editorObservers, () => _deps.isSelected(this), () => _deps.onStateChanged(this));

    const statusSink = { text: '' };
    Object.defineProperty(statusSink, 'text', {
      get: () => `Live Tests: ${this.statusText}`,
      set: (v: string) => {
        this.statusText = String(v).replace(/^Live Tests: /, '');
        _deps.onStatusText(this);
      },
    });

    this.session = new SessionManager(
      this.root,
      this.services,
      this.store,
      this.traceStore,
      this.coverageStore,
      _deps.selection,
      { sendScopedData: (fileId, nodeId) => { if (_deps.isSelected(this)) { _deps.sendScopedData(fileId, nodeId); } } },
      [this.gate],
      _deps.outputChannel,
      statusSink,
      this.discovery,
    );

    // Coverage reaches the views (badge, Coverage tab) only for the selected project.
    this._disposables.push(
      this.coverageStore,
      this.coverageStore.onDidChange.event(() => {
        this.gate.onCoverageUpdated(this.coverageStore.getTotals(), this.coverageStore.getFileRows());
      }),
    );
  }

  /** Static discovery runs once per project — at activation for the selected one, on first selection or Start for the others. */
  ensureDiscovery(): void {
    if (this._discoveryStarted) { return; }
    this._discoveryStarted = true;
    if (!this.discoveryCache) {
      this.discoveryCache = new DiscoveryCache(this._deps.cacheRootDir, this.root);
      this.discoveryCache.writeLock();
    }
    this.startDiscovery();
  }

  /** (Re)starts discovery from scratch with the project's cache. */
  startDiscovery(): void {
    this._discoveryStarted = true;
    this.discovery.start(this.root, this.store, this.discoveryCallbacks(), this.discoveryCache, this.discoverer);
  }

  get discoveryStarted(): boolean { return this._discoveryStarted; }

  discoveryCallbacks(): DiscoveryCallbacks {
    return {
      onFilesFound: (total) => this.gate.onDiscoveryStarted(total),
      onBatchDiscovered: (files, discovered, total) => this.gate.onDiscoveryProgress(files, discovered, total),
      onComplete: () => this.gate.onDiscoveryComplete(),
      onFileRemoved: (fileId) => this.gate.onDiscoveryFileRemoved(fileId),
    };
  }

  /** Deletes the project's trace files and forgets their indexes (every Start). */
  cleanTraceDir(): void {
    try { fs.rmSync(this.traceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.traceStore.clearAll();
  }

  /** "jest", "vitest", or "jest + vitest" once a Start found a mixed project. */
  get frameworkLabel(): string {
    if (!this.services.isMixed()) { return this.framework; }
    return this.framework === 'vitest' ? 'vitest + jest' : `${this.framework} + vitest`;
  }

  /** Run state for the switcher row. */
  get runState(): ProjectRunState {
    if (this.session.isRunning()) { return 'running'; }
    if (this.session.isActive()) { return 'watching'; }
    if (this.gate.isDiscovering) { return 'discovering'; }
    return 'idle';
  }

  summary(selected: boolean): ProjectSummary {
    const s = this.store.getSummary();
    const running = this.session.isRunning();
    const p = this.session.progress();
    return {
      id: this.id,
      name: this.name,
      relPath: this.relPath,
      framework: this.frameworkLabel,
      state: this.runState,
      total: s.total,
      passed: s.passed,
      failed: s.failed,
      progress: running ? { completed: p.completed, total: p.total } : undefined,
      selected,
    };
  }

  viewState(): ProjectViewState {
    const running = this.session.isRunning() ? this.session.progress() : undefined;
    return {
      store: this.store,
      coverageStore: this.coverageStore,
      traceStore: this.traceStore,
      sessionActive: this.gate.sessionActive,
      isDiscovering: this.gate.isDiscovering,
      discoveryTotal: this.gate.discoveryTotal,
      discoveryDone: this.gate.discoveryDone,
      running,
    };
  }

  /** Stops the session (kills its processes) and releases the discovery lock. */
  dispose(): void {
    try { this.session.dispose(); } catch (err) { log.debug(`Stopping "${this.name}" failed: ${(err as Error).message}`); }
    this.discovery.dispose();
    this.discoveryCache?.releaseLock();
    for (const d of this._disposables) { d.dispose(); }
    this.cleanTraceDir();
  }
}

/**
 * The project's only observer: keeps the state the switcher row and a later
 * switch need, and forwards each event to the window's observers while the
 * project is selected.
 */
export class ProjectObserverGate implements IResultObserver {
  sessionActive = false;
  isDiscovering = false;
  discoveryTotal = 0;
  discoveryDone = 0;

  constructor(
    private readonly _ctx: ProjectContext,
    private readonly _observers: IResultObserver[],
    private readonly _editorObservers: Partial<IResultObserver>[],
    private readonly _isSelected: () => boolean,
    private readonly _changed: () => void,
  ) {}

  private _forward(method: keyof IResultObserver, args: unknown[]): void {
    for (const o of this._editorObservers) {
      const fn = o[method] as unknown;
      if (typeof fn === 'function') { (fn as (...a: unknown[]) => void).apply(o, args); }
    }
    if (!this._isSelected()) { return; }
    for (const o of this._observers) {
      const fn = o[method] as unknown;
      if (typeof fn === 'function') { (fn as (...a: unknown[]) => void).apply(o, args); }
    }
  }

  onSessionStarted(): void { this.sessionActive = true; this._forward('onSessionStarted', []); this._changed(); }
  onSessionStopped(): void { this.sessionActive = false; this._forward('onSessionStopped', []); this._changed(); }
  onRunStarted(payload: RunStartedPayload): void { this._forward('onRunStarted', [payload]); this._changed(); }
  onFilesRerunning(fileIds: string[], nodeId?: string): void { this._forward('onFilesRerunning', [fileIds, nodeId]); this._changed(); }
  onFileResult(filePath: string): void { this._forward('onFileResult', [filePath]); this._changed(); }
  onRunFinished(payload: RunFinishedPayload): void {
    if (payload.sessionActive === false) { this.sessionActive = false; }
    this._forward('onRunFinished', [payload]);
    this._changed();
  }
  onRunProgress(completed: number, total: number, failed: number): void { this._forward('onRunProgress', [completed, total, failed]); this._changed(); }
  onTracingProgress(completed: number, total: number, done?: boolean): void { this._forward('onTracingProgress', [completed, total, done]); }
  onSourceScanProgress(scanned: number, total: number): void { this._forward('onSourceScanProgress', [scanned, total]); }
  onSourceScanDone(): void { this._forward('onSourceScanDone', []); }
  onCoverageUpdated(totals: CoverageTotals, files: CoverageFileRow[]): void { this._forward('onCoverageUpdated', [totals, files]); }

  onDiscoveryStarted(total: number): void {
    this.isDiscovering = true;
    this.discoveryTotal = total;
    this.discoveryDone = 0;
    this._forward('onDiscoveryStarted', [total]);
    this._changed();
  }
  onDiscoveryProgress(files: unknown[], discovered: number, total: number): void {
    this.discoveryDone = discovered;
    this._forward('onDiscoveryProgress', [files, discovered, total]);
  }
  onDiscoveryComplete(): void {
    this.isDiscovering = false;
    this._forward('onDiscoveryComplete', []);
    this._changed();
  }
  onDiscoveryFileRemoved(fileId: string): void { this._forward('onDiscoveryFileRemoved', [fileId]); }

  dispose(): void { /* nothing held */ }

  /** For logs. */
  toString(): string { return `gate(${this._ctx.name})`; }
}
