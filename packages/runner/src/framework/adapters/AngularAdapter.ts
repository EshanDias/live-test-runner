import { FRAMEWORK_IDS, FrameworkCapabilities, FrameworkId, RunResult } from '../../types';
import { RunnerOptions, TestRunner } from '../../TestRunner';
import { FrameworkAdapter } from './FrameworkAdapter';
import type { VitestAdapter, VitestInstall } from './VitestAdapter';
import { parseVitestResult } from '../../parsing/VitestResultParser';
import { readAngularWorkspace } from '../angularWorkspace';
import { resolvePackageBin } from '../../resolution/BinaryResolver';
import type { AngularRunner as AngularRunnerType } from '../../AngularRunner';
import { createLogger } from '../../utils/logger';

const log = createLogger('AngularAdapter');

/**
 * Angular projects tested with Vitest through Angular's unit-test builder
 * (`ng test`; the default for new apps since Angular 21). Plain `vitest run`
 * cannot run them (no Angular compilation, no TestBed setup), so the
 * project's own Angular CLI runs them: `ng test <project>` with our
 * reporters and a runner config of our own in the session folder.
 *
 * Detection: an angular.json in the folder with a project whose `test`
 * target uses the unit-test builder with the Vitest runner. Must be checked
 * before Vitest (the app also depends on vitest) and Jest.
 *
 * Results come from Vitest's json reporter and ours, as for Vitest. Not
 * available: the related run (the builder has none; the extension finds the
 * importing test files itself).
 */
export class AngularAdapter implements FrameworkAdapter {
  readonly framework: FrameworkId = FRAMEWORK_IDS.angular;

  /** Vitest's adapter for its install checks (version, Node). Created on first use: it imports the registry that imports this adapter. */
  private _vitest?: VitestAdapter;
  private get vitest(): VitestAdapter {
    return this._vitest ??= new (require('./VitestAdapter') as { VitestAdapter: new () => VitestAdapter }).VitestAdapter();
  }

  /** The Vitest the builder runs (its version decides the capabilities). */
  findInstall(projectRoot: string): VitestInstall | undefined {
    return this.vitest.findInstall(projectRoot);
  }

  detect(projectRoot: string): boolean {
    return (readAngularWorkspace(projectRoot)?.projects.length ?? 0) > 0;
  }

  capabilities(projectRoot: string): FrameworkCapabilities {
    return { ...this.vitest.capabilities(projectRoot), related: false, listTests: true, liveStream: true };
  }

  /** The project's Angular CLI (`@angular/cli/bin/ng.js`), run with node. */
  resolveBinary(projectRoot: string): string {
    const ng = resolvePackageBin('@angular/cli', 'ng', projectRoot, 'bin/ng.js');
    if (!ng) {
      const msg =
        `[Live Test Runner] The Angular CLI is not installed in ${projectRoot}. ` +
        'Run your package manager\'s install (npm / pnpm / yarn) and try again.';
      log.error(msg);
      throw new Error(msg);
    }
    // Vitest's own checks (installed, version, Node) still apply: the builder runs it.
    this.vitest.resolveBinary(projectRoot);
    return ng;
  }

  /** No `--config`: the builder takes ours as `--runner-config` (AngularRunner). */
  async resolveConfig(): Promise<string | undefined> {
    return undefined;
  }

  /** The builder's options, not Vitest's CLI flags. */
  getExtraArgs(): string[] {
    return [];
  }

  outputFileArg(file: string): string[] {
    return ['--output-file', file];
  }

  /** Vitest's json reporter. */
  parseResult(passed: boolean, raw: string, stderr: string): RunResult {
    return parseVitestResult(passed, raw, stderr);
  }

  createRunner(options: RunnerOptions = {}): TestRunner {
    // Loaded here: AngularRunner extends VitestRunner, which imports the registry that imports this adapter.
    const { AngularRunner } = require('../../AngularRunner') as { AngularRunner: typeof AngularRunnerType };
    return new AngularRunner(options.command ?? '', options.logger, options.tmpDir);
  }
}
