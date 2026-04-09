import { BaseWebviewProvider } from './BaseWebviewProvider';

export class ExplorerView extends BaseWebviewProvider {
  public static readonly viewId = 'liveTestRunner.explorer';

  protected get _htmlFile(): string { return 'explorer.html'; }

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
