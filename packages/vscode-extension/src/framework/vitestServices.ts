/**
 * The Vitest {@link FrameworkServices} bundle. The only place outside the
 * Vitest classes themselves that builds them.
 */
import * as vscode from 'vscode';
import { CommandRunner, FRAMEWORK_IDS, VitestAdapter as VitestRunnerAdapter } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { VitestAdapter, vitestCommandSetting } from './VitestAdapter';
import { VitestProjectConfig } from '../session/VitestProjectConfig';
import { VitestBatchRunner } from '../session/VitestBatchRunner';

export function createVitestServices(options: {
  /** The window's session folder (result files). */
  sessionDir: string;
  /** Sink for raw Vitest output (the "Test Output" channel). */
  rawLog: (msg: string) => void;
}): FrameworkServices {
  const { sessionDir, rawLog } = options;
  const runnerAdapter = new VitestRunnerAdapter();
  const newRunner = (logger: (msg: string) => void) =>
    runnerAdapter.createRunner({ command: vitestCommandSetting(), logger, tmpDir: sessionDir }) as CommandRunner;
  return {
    framework: FRAMEWORK_IDS.vitest,
    displayName: 'Vitest',
    terms: {
      name: 'Vitest',
      config: 'Vitest config',
      configRulesShort: 'include / exclude',
      configRules: 'include / exclude / projects',
      listCommand: 'vitest list',
      relatedCommand: 'vitest related',
      batchRun: 'Vitest batch',
      plainRun: 'plain Vitest',
      fallbackLoss: 'slower',
    },
    // Trace needs the Vite plugin (phase 9), the Timeline its runner (phase 10).
    features: { trace: false, timeline: false },
    adapter: new VitestAdapter(sessionDir),
    projectConfig: new VitestProjectConfig(),
    batchRunner: new VitestBatchRunner(newRunner),
    // The Timeline debugger needs the Vite trace plugin (phase 10).
    instrumentedRunner: undefined,
    createSessionRunner: () => newRunner(rawLog),
    settingsFingerprint: () => {
      const cfg = vscode.workspace.getConfiguration('liveTestRunner');
      return `vitest|${cfg.get<string>('vitestCommand') ?? ''}`;
    },
  };
}
