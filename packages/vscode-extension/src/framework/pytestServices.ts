/**
 * The pytest {@link FrameworkServices} bundle. The only place outside the
 * pytest classes themselves that builds them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FRAMEWORK_IDS, PytestAdapter as PytestRunnerAdapter, CommandRunner, PYTEST_CONFIG_FILES, LTR_PYTEST_SOURCE, pythonFor } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { PytestAdapter, pytestArgsSetting } from './PytestAdapter';
import { PytestProjectConfig } from '../session/PytestProjectConfig';
import { PytestBatchRunner } from '../session/PytestBatchRunner';
import { CoverageStore } from '../coverage/CoverageStore';
import { pythonInterpreters } from '../python/PythonInterpreters';

const PLUGIN_HASH = crypto.createHash('sha1').update(LTR_PYTEST_SOURCE).digest('hex').slice(0, 12);

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
    // One pytest process at a time, every file in it — as the user's own `pytest`:
    // projects share session fixtures, ports and files between tests (httpx's
    // test server binds a fixed port), so two processes side by side can deadlock.
    // Results still stream per file; session fixtures are set up once per batch.
    // 300 relative paths stay far below Windows' 32k command-line limit.
    batchPolicy: { maxParallel: 1, maxFilesPerBatch: 300 },
    terms: {
      name: 'pytest',
      config: 'pytest config',
      configRulesShort: 'testpaths / python_files',
      configRules: 'testpaths / python_files / norecursedirs',
      listCommand: 'pytest --collect-only',
      relatedCommand: 'the test files that import it',
      batchRun: 'pytest batch',
      plainRun: 'plain pytest',
      fallbackLoss: 'slower; no coverage for these files',
    },
    // Covering tests come from coverage.py's per-test contexts (pytest plan phase 6); the Timeline is a later release (D6).
    features: { trace: true, timeline: false },
    traceOffReason: (projectRoot) => pythonFor(projectRoot) && !pythonFor(projectRoot)!.coverage
      ? "the coverage package is not installed in the project's Python environment"
      : undefined,
    adapter: new PytestAdapter(sessionDir),
    projectConfig,
    batchRunner: new PytestBatchRunner(newRunner, { store: coverageStore, sessionDir, projectConfig }),
    instrumentedRunner: undefined,
    createSessionRunner: () => newRunner(rawLog),
    whyNotReady: async (projectRoot) => {
      try {
        await pythonInterpreters().ensure(projectRoot);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
    settingsFingerprint: () => {
      const cfg = vscode.workspace.getConfiguration('liveTestRunner');
      // The plugin's version too: a newer plugin may list files differently.
      return `pytest|${PLUGIN_HASH}|${cfg.get<string>('pythonPath') ?? ''}|${JSON.stringify(cfg.get('pytestArgs') ?? [])}`;
    },
    configFileNames: [...PYTEST_CONFIG_FILES, 'conftest.py'],
    // A pytest config file or a conftest.py in the root changes what is collected and how.
    isConfigFile: async (filePath, projectRoot) => {
      if (path.dirname(filePath) !== projectRoot) { return false; }
      const name = path.basename(filePath);
      if (name === 'conftest.py') { return true; }
      return PYTEST_CONFIG_FILES.includes(name) && (await projectConfig.get(projectRoot)) === filePath;
    },
  };
}
