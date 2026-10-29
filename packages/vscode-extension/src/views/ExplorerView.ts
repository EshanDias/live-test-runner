import * as vscode from 'vscode';
import { BaseWebviewProvider } from './BaseWebviewProvider';
import { CoverageStore } from '../coverage/CoverageStore';
import { ResultStore } from '../store/ResultStore';
import { SelectionState } from '../store/SelectionState';
import type { ProjectSummary, ProjectViewState } from '../project/ProjectContext';

export class ExplorerView extends BaseWebviewProvider {
  public static readonly viewId = 'liveTestRunner.explorer';

  protected get _htmlFile(): string { return 'explorer.html'; }

  /** Called by extension.ts when the sidebar Re-run button is clicked. */
  onTimelineRerun: (() => void) | null = null;
  /** Called when timeline sidebar requests exiting timeline mode. */
  onTimelineExitRequest: (() => void) | null = null;

  constructor(
    extensionUri: vscode.Uri,
    store: ResultStore,
    selection: SelectionState,
    private _coverageStore: CoverageStore,
  ) {
    super(extensionUri, store, selection);
  }

  /** The workspace's projects for the switcher row (shown only when there are two or more). */
  private _projects: ProjectSummary[] = [];

  bindProject(state: ProjectViewState): void {
    this._coverageStore = state.coverageStore;
    super.bindProject(state);
  }

  /** Updates the switcher row (project list and live state). */
  setProjects(projects: ProjectSummary[]): void {
    this._projects = projects;
    this.postMessage({ type: 'projects', projects });
  }

  protected handleExtraMessage(msg: { type: string; filePath?: string; testFullName?: string }): void {
    if (msg.type === 'open-timeline' && msg.filePath && msg.testFullName) {
      vscode.commands.executeCommand(
        'liveTestRunner.openTimelineDebugger',
        msg.filePath,
        msg.testFullName,
      );
      return;
    }
    if (msg.type === 'timeline-rerun') {
      this.onTimelineRerun?.();
      return;
    }
    if (msg.type === 'timeline-exit-request') {
      this.onTimelineExitRequest?.();
      return;
    }
    if (msg.type === 'select-project') {
      const id = (msg as { id?: string }).id;
      vscode.commands.executeCommand('liveTestRunner.selectProject', id);
    }
  }

  protected _sendInit(): void {
    const summary = this.store.getSummary();
    const sel     = this.selection.get();
    this.postMessage({
      type:               'init',
      files:              (this.store.toJSON() as { files: unknown[] }).files,
      total:              summary.total,
      passed:             summary.passed,
      failed:             summary.failed,
      runningTests:       summary.running,
      thresholds:         this._getThresholds(),
      coverageThresholds: this._getCoverageThresholds(),
      coverageTotals:     this._coverageStore.getTotals(),
      coverageFiles:      this._coverageStore.getFileRows(),
      sessionActive:      this._sessionActive,
      isDiscovering:      this._isDiscovering,
      discoveryTotal:     this._discoveryTotal,
      discoveryDone:      this._discoveryDone,
      selection:          sel ? { fileId: sel.fileId, nodeId: sel.nodeId } : null,
      running:            this._running ?? null,
      projects:           this._projects,
    });
  }
}
