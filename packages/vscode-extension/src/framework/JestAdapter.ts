import * as path from 'path';
import * as vscode from 'vscode';
import {
  JestRunner,
  BinaryResolver,
  FrameworkDetector,
  FRAMEWORK_IDS,
  toJestPathArg,
  registerProjectRoot,
} from '@live-test-runner/runner';
import { RunnerBackedAdapter } from './RunnerBackedAdapter';
import { nameToPattern } from '../utils/testNames';

/**
 * JestAdapter — the Jest-specific part of the extension's framework adapter
 * (plain Jest and Create React App): detection, the JestRunner with the
 * user's liveTestRunner.jestCommand / runMode, and the debug launch config.
 * Result mapping and the run operations are in RunnerBackedAdapter.
 */
export class JestAdapter extends RunnerBackedAdapter {
  protected readonly displayName = 'Jest';

  // ── Detection ──────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
      );
      return (
        !!pkg.dependencies?.jest ||
        !!pkg.devDependencies?.jest ||
        !!pkg.scripts?.test?.includes('jest')
      );
    } catch (err) {
      this.log.warn(`Could not read ${projectRoot}/package.json — assuming this is not a Jest project`, err);
      return false;
    }
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  async getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration> {
    // Jest's JS entry point, resolved from the project root (not the workspace
    // folder) — `.bin/jest` is a shell script on Windows and cannot be a program.
    registerProjectRoot(projectRoot);
    const framework = new FrameworkDetector().detect(projectRoot);
    const isCra = framework.framework === FRAMEWORK_IDS.cra;
    const program =
      (isCra ? BinaryResolver.resolveCraJestEntry(projectRoot) : BinaryResolver.resolveJestEntry(projectRoot))
      ?? path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');

    const args: string[] = [];
    if (isCra) {
      // CRA keeps its Jest config inside react-scripts — use the extracted copy.
      const config = await framework.resolveConfig(projectRoot);
      if (config) { args.push('--config', config); }
    }
    // --config / --resetMocks … from the project's test script, like npm test.
    args.push(...framework.getExtraArgs(projectRoot));
    args.push('--runTestsByPath', toJestPathArg(filePath));
    if (testFullName) {
      const p = nameToPattern(testFullName);
      args.push('--testNamePattern', isSuite ? `^(?:${p})(?: |$)` : `^(?:${p})$`);
    }
    args.push('--runInBand', '--no-coverage', '--watchAll=false');
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Jest test',
      program,
      args,
      cwd: projectRoot,
      console: 'integratedTerminal',
      env: { NODE_ENV: 'test', BABEL_ENV: 'test' },
      skipFiles: ['<node_internals>/**'],
    };
  }

  protected createRunner(rawLog: (msg: string) => void): JestRunner {
    return new JestRunner(jestCommandSetting(), rawLog, this._tmpDir);
  }
}

/** The user's Jest command override: `npm test --` in npm run mode, else `liveTestRunner.jestCommand` ('' = local install). */
export function jestCommandSetting(): string {
  const cfg = vscode.workspace.getConfiguration('liveTestRunner');
  if (cfg.get<string>('runMode') === 'npm') {
    return 'npm test --';
  }
  return cfg.get<string>('jestCommand') || '';
}
