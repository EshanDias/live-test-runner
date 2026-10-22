/**
 * The Vitest {@link FrameworkServices} bundle. The only place outside the
 * Vitest classes themselves that builds them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandRunner, FRAMEWORK_IDS, VitestAdapter as VitestRunnerAdapter } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { VitestAdapter, vitestCommandSetting, vitestIncludeBrowserProjects } from './VitestAdapter';
import { VitestProjectConfig } from '../session/VitestProjectConfig';
import { VitestBatchRunner } from '../session/VitestBatchRunner';
import { CoverageStore } from '../coverage/CoverageStore';

export function createVitestServices(options: {
  /** The window's session folder (result, event and coverage files). */
  sessionDir: string;
  coverageStore: CoverageStore;
  /** Sink for raw Vitest output (the "Test Output" channel). */
  rawLog: (msg: string) => void;
}): FrameworkServices {
  const { sessionDir, rawLog, coverageStore } = options;
  const runnerAdapter = new VitestRunnerAdapter();
  const projectConfig = new VitestProjectConfig();
  const newRunner = (logger: (msg: string) => void) =>
    runnerAdapter.createRunner({
      command: vitestCommandSetting(),
      logger,
      tmpDir: sessionDir,
      includeBrowserProjects: vitestIncludeBrowserProjects(),
    }) as CommandRunner;
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
    projectConfig,
    batchRunner: new VitestBatchRunner(newRunner, { store: coverageStore, sessionDir }),
    // The Timeline debugger needs the Vite trace plugin (phase 10).
    instrumentedRunner: undefined,
    createSessionRunner: () => newRunner(rawLog),
    settingsFingerprint: () => {
      const cfg = vscode.workspace.getConfiguration('liveTestRunner');
      return `vitest|${cfg.get<string>('vitestCommand') ?? ''}|${cfg.get<boolean>('vitestIncludeBrowserProjects') ? 'browser' : ''}`;
    },
    // vitest.config.* / vite.config.* / vitest.workspace.* in the root, or the config the test script names.
    isConfigFile: async (filePath, projectRoot) => {
      if (path.dirname(filePath) === projectRoot && /^vite(st)?\.(config|workspace)\.[cm]?[jt]s$/.test(path.basename(filePath))) { return true; }
      const config = await projectConfig.get(projectRoot).catch(() => undefined);
      return !!config && path.resolve(projectRoot, config) === filePath;
    },
  };
}
