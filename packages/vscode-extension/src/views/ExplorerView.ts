import * as vscode from 'vscode';
import { BaseWebviewProvider } from './BaseWebviewProvider';

export class ExplorerView extends BaseWebviewProvider {
  public static readonly viewId = 'liveTestRunner.explorer';

  protected get _htmlFile(): string { return 'explorer.html'; }

  /** Called by extension.ts when the sidebar Re-run button is clicked. */
  onTimelineRerun: (() => void) | null = null;

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
    }
  }

  protected _sendInit(): void {
    const summary = this.store.getSummary();
    this.postMessage({
      type:          'init',
      files:         (this.store.toJSON() as { files: unknown[] }).files,
      total:         summary.total,
      passed:        summary.passed,
      failed:        summary.failed,
      thresholds:    this._getThresholds(),
      sessionActive: this._sessionActive,
    });
  }
}
