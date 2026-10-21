import * as path from 'path';
import * as vscode from 'vscode';
import {
  VitestAdapter as VitestRunnerAdapter,
  VitestRunner,
  registerProjectRoot,
  toVitestNamePattern,
  toVitestPathArg,
  toSpawnPath,
} from '@live-test-runner/runner';
import { RunnerBackedAdapter } from './RunnerBackedAdapter';
import { nameToPattern } from '../utils/testNames';
import { logger } from '../utils/logger';

const log = logger.scope('Vitest');

/**
 * VitestAdapter — the Vitest-specific part of the extension's framework
 * adapter: detection, the VitestRunner with liveTestRunner.vitestCommand,
 * and the debug launch config. Result mapping and the run operations are in
 * RunnerBackedAdapter (shared with Jest).
 */
export class VitestAdapter extends RunnerBackedAdapter {
  protected readonly displayName = 'Vitest';
  private readonly _runnerAdapter = new VitestRunnerAdapter();

  async detect(projectRoot: string): Promise<boolean> {
    return this._runnerAdapter.detect(projectRoot);
  }

  /**
   * Vitest's recommended VS Code launch: its CLI entry run with node, child
   * processes auto-attached (tests run in workers), one file at a time and
   * no timeouts while paused at a breakpoint.
   */
  async getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration> {
    registerProjectRoot(projectRoot);
    // Entry, cwd, config and filter in one spelling, like the runs (toSpawnPath).
    const program = toSpawnPath(this._runnerAdapter.findInstall(projectRoot)?.entry
      ?? path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'));
    const args = ['run', toVitestPathArg(filePath)];
    const config = await this._runnerAdapter.resolveConfig(projectRoot);
    if (config) { args.push('--config', toSpawnPath(config)); }
    args.push(...this._runnerAdapter.getExtraArgs(projectRoot));
    if (testFullName) {
      args.push('-t', toVitestNamePattern(nameToPattern(testFullName), isSuite));
    }
    args.push('--no-file-parallelism', '--test-timeout=0', '--hook-timeout=0', '--coverage.enabled=false', '--watch=false');
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Vitest test',
      program,
      args,
      cwd: toSpawnPath(projectRoot),
      console: 'integratedTerminal',
      autoAttachChildProcesses: true,
      smartStep: true,
      env: { NODE_ENV: 'test' },
      skipFiles: ['<node_internals>/**', '**/node_modules/**'],
    };
  }

  protected createRunner(rawLog: (msg: string) => void): VitestRunner {
    return this._runnerAdapter.createRunner({
      command: vitestCommandSetting(),
      logger: rawLog,
      tmpDir: this._tmpDir,
      includeBrowserProjects: vitestIncludeBrowserProjects(),
    }) as VitestRunner;
  }
}

/** `liveTestRunner.vitestIncludeBrowserProjects`: run Vitest browser-mode projects too. */
export function vitestIncludeBrowserProjects(): boolean {
  return vscode.workspace.getConfiguration('liveTestRunner').get<boolean>('vitestIncludeBrowserProjects') ?? false;
}

let _warnedNpmMode = false;

/**
 * The user's Vitest command override (`liveTestRunner.vitestCommand`; '' =
 * the project's own install). `runMode: npm` is Jest-only — `npm test --`
 * would append our args after the script's own (`vitest run run <file>`).
 */
export function vitestCommandSetting(): string {
  const cfg = vscode.workspace.getConfiguration('liveTestRunner');
  if (cfg.get<string>('runMode') === 'npm' && !_warnedNpmMode) {
    _warnedNpmMode = true;
    log.warn('liveTestRunner.runMode "npm" applies to Jest only — Vitest is run directly. Use liveTestRunner.vitestCommand to change how it is called.');
  }
  return cfg.get<string>('vitestCommand') || '';
}
