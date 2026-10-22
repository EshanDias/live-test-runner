import { VitestAdapter as VitestRunnerAdapter, vitestConfigInfo } from '@live-test-runner/runner';
import { IProjectConfig } from './IProjectConfig';
import { CoverageScope, vitestCoverageScope } from '../coverage/coverageScope';

/**
 * The Vitest config file a project uses (the test script's `--config`, else
 * `vitest.config.*`, else `vite.config.*`). Vitest loads and resolves its
 * config itself, so this is the file path, not a resolved copy — the trace
 * work (task 9.1) wraps it with mergeConfig.
 */
export class VitestProjectConfig implements IProjectConfig {
  private readonly _adapter = new VitestRunnerAdapter();
  private readonly _cache = new Map<string, Promise<string | undefined>>();

  /** @param _tmpDir where the config probe script is written (the session folder) */
  constructor(private readonly _tmpDir: string) {}

  get(projectRoot: string): Promise<string | undefined> {
    let p = this._cache.get(projectRoot);
    if (!p) {
      p = this._adapter.resolveConfig(projectRoot);
      this._cache.set(projectRoot, p);
    }
    return p;
  }

  /** From the resolved config (the same cached probe the runs read the coverage provider from). */
  async coverageScope(projectRoot: string): Promise<CoverageScope | undefined> {
    try {
      const info = await vitestConfigInfo(projectRoot, await this.get(projectRoot), this._tmpDir);
      return info?.coverage ? vitestCoverageScope(info.coverage) : undefined;
    } catch {
      return undefined;
    }
  }

  reset(): void {
    this._cache.clear();
  }
}
