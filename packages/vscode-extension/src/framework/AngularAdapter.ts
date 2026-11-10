import * as path from 'path';
import * as vscode from 'vscode';
import {
  AngularAdapter as AngularRunnerAdapter,
  AngularRunner,
  angularProjectOf,
  readAngularWorkspace,
  registerProjectRoot,
  toVitestNamePattern,
  toSpawnPath,
} from '@live-test-runner/runner';
import { RunnerBackedAdapter } from './RunnerBackedAdapter';
import { nameToPattern } from '../utils/testNames';

/**
 * AngularAdapter — Angular projects tested with Vitest through Angular's
 * unit-test builder (`ng test`). Runs, results and output mapping are
 * RunnerBackedAdapter's (as for Vitest); this adds detection, the runner and
 * the debug launch.
 */
export class AngularAdapter extends RunnerBackedAdapter {
  protected readonly displayName = 'Angular';
  private readonly _runnerAdapter = new AngularRunnerAdapter();

  async detect(projectRoot: string): Promise<boolean> {
    return this._runnerAdapter.detect(projectRoot);
  }

  /**
   * The project's Angular CLI under the debugger: `ng test <project>` for
   * the one file (and name filter), child processes attached (Vitest runs
   * in workers), output in the Debug Console. No coverage, no watch.
   */
  async getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration> {
    registerProjectRoot(projectRoot);
    const ws = readAngularWorkspace(projectRoot);
    const project = ws ? angularProjectOf(ws, filePath) ?? ws.projects[0] : undefined;
    const args = ['test', ...(project ? [project.name] : []), '--watch=false', '--include', path.relative(projectRoot, filePath).split(path.sep).join('/')];
    if (testFullName) {
      args.push('--filter', toVitestNamePattern(nameToPattern(testFullName), isSuite));
    }
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Angular test',
      program: toSpawnPath(this._runnerAdapter.resolveBinary(projectRoot)),
      args,
      cwd: toSpawnPath(projectRoot),
      // As for Vitest: started directly (a command typed into a terminal can be lost), output in the Debug Console.
      console: 'internalConsole',
      outputCapture: 'std',
      autoAttachChildProcesses: true,
      smartStep: true,
      // CI: Angular's build cache stays out of the project.
      env: { NODE_ENV: 'test', CI: 'true' },
      skipFiles: ['<node_internals>/**', '**/node_modules/**'],
    };
  }

  protected createRunner(rawLog: (msg: string) => void): AngularRunner {
    return this._runnerAdapter.createRunner({ logger: rawLog, tmpDir: this._tmpDir }) as AngularRunner;
  }
}
