/**
 * The pytest {@link FrameworkServices} bundle. The only place outside the
 * pytest classes themselves that builds them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { FRAMEWORK_IDS, PytestAdapter as PytestRunnerAdapter, CommandRunner, PYTEST_CONFIG_FILES } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { PytestAdapter, pytestArgsSetting } from './PytestAdapter';
import { PytestProjectConfig } from '../session/PytestProjectConfig';
import { PytestBatchRunner } from '../session/PytestBatchRunner';
import { CoverageStore } from '../coverage/CoverageStore';

export function createPytestServices(options: {
  /** The project's session folder (plugin, results, events, coverage). */
  sessionDir: string;
  coverageStore: CoverageStore;
  /** Sink for raw pytest output (the "Test Output" channel). */
  rawLog: (msg: string) => void;
}): FrameworkServices {
  const { sessionDir, rawLog, coverageStore } = options;
  const runnerAdapter = new PytestRunnerAdapter();
  const projectConfig = new PytestProjectConfig();
  const newRunner = (logger: (msg: string) => void) =>
    runnerAdapter.createRunner({ logger, tmpDir: sessionDir, pytestArgs: pytestArgsSetting() }) as CommandRunner;
  return {
    framework: FRAMEWORK_IDS.pytest,
    displayName: 'pytest',
    terms: {
      name: 'pytest',
      config: 'pytest config',
      configRulesShort: 'testpaths / python_files',
      configRules: 'testpaths / python_files / norecursedirs',
      listCommand: 'pytest --collect-only',
      relatedCommand: 'covering tests',
      batchRun: 'pytest batch',
      plainRun: 'plain pytest',
      fallbackLoss: 'slower; no coverage for these files',
    },
    // Covering tests from coverage contexts come in 3.3 (pytest plan phase 6); the Timeline is a later release (D6).
    features: { trace: false, timeline: false },
    adapter: new PytestAdapter(sessionDir),
    projectConfig,
    batchRunner: new PytestBatchRunner(newRunner, { store: coverageStore, sessionDir, projectConfig }),
    instrumentedRunner: undefined,
    createSessionRunner: () => newRunner(rawLog),
    settingsFingerprint: () => {
      const cfg = vscode.workspace.getConfiguration('liveTestRunner');
      return `pytest|${cfg.get<string>('pythonPath') ?? ''}|${JSON.stringify(cfg.get('pytestArgs') ?? [])}`;
    },
    // A pytest config file or a conftest.py in the root changes what is collected and how.
    isConfigFile: async (filePath, projectRoot) => {
      if (path.dirname(filePath) !== projectRoot) { return false; }
      const name = path.basename(filePath);
      if (name === 'conftest.py') { return true; }
      return PYTEST_CONFIG_FILES.includes(name) && (await projectConfig.get(projectRoot)) === filePath;
    },
  };
}
