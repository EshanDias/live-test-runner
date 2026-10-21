import { VitestAdapter as VitestRunnerAdapter } from '@live-test-runner/runner';
import { IProjectConfig } from './IProjectConfig';

/**
 * The Vitest config file a project uses (the test script's `--config`, else
 * `vitest.config.*`, else `vite.config.*`). Vitest loads and resolves its
 * config itself, so this is the file path, not a resolved copy — the trace
 * work (task 9.1) wraps it with mergeConfig.
 */
export class VitestProjectConfig implements IProjectConfig {
  private readonly _adapter = new VitestRunnerAdapter();
  private readonly _cache = new Map<string, Promise<string | undefined>>();

  get(projectRoot: string): Promise<string | undefined> {
    let p = this._cache.get(projectRoot);
    if (!p) {
      p = this._adapter.resolveConfig(projectRoot);
      this._cache.set(projectRoot, p);
    }
    return p;
  }

  reset(): void {
    this._cache.clear();
  }
}
