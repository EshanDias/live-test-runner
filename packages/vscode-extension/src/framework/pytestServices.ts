/**
 * The pytest {@link FrameworkServices} bundle. The only place outside the
 * pytest classes themselves that builds them.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FRAMEWORK_IDS, PytestAdapter as PytestRunnerAdapter, CommandRunner, PYTEST_CONFIG_FILES, LTR_PYTEST_SOURCE, pythonFor, pytestSettings, addoptsRunInParallel } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { PytestAdapter, pytestArgsSetting } from './PytestAdapter';
import { PytestProjectConfig } from '../session/PytestProjectConfig';
import { PytestBatchRunner } from '../session/PytestBatchRunner';
import { CoverageStore } from '../coverage/CoverageStore';
import { pythonInterpreters } from '../python/PythonInterpreters';
import { logger } from '../utils/logger';

const log = logger.scope('Pytest');

/** Per project: whether its suite runs in parallel itself (read again after 10 s: the scheduler asks often). */
const _parallel = new Map<string, { value: boolean; at: number }>();
function runsInParallel(root: string): boolean {
  const known = _parallel.get(root);
  if (known && Date.now() - known.at < 10_000) { return known.value; }
  let value = false;
  try { value = !!pythonFor(root)?.xdist && addoptsRunInParallel(pytestSettings(root).addopts); } catch { /* unreadable config: one at a time */ }
  if (known?.value !== value) {
    log.debug(value
      ? `${path.basename(root)}: the project runs pytest in parallel itself (pytest-xdist in addopts) — several pytest processes may run at once`
      : `${path.basename(root)}: one pytest process at a time (the suite does not run in parallel itself)`);
  }
  _parallel.set(root, { value, at: Date.now() });
  return value;
}

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
    language: 'python',
    displayName: 'pytest',
    // One pytest process at a time — as the user's own `pytest`: projects share
    // session fixtures, ports and files between tests (httpx's test server binds
    // a fixed port), so two processes side by side can deadlock. A suite the
    // project itself runs in parallel (pytest-xdist workers in its addopts) is
    // built for that: then as many as the budget allows. Results still stream
    // per file. 300 relative paths stay far below Windows' 32k command-line limit.
    batchPolicy: { maxParallel: (root) => (runsInParallel(root) ? undefined : 1), maxFilesPerBatch: 300 },
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
    // Covering tests come from coverage.py's per-test contexts; the Timeline is not built for pytest yet.
    features: { trace: true, timeline: false },
    traceOffReason: (projectRoot) => pythonFor(projectRoot) && !pythonFor(projectRoot)!.coverage
      ? "the coverage package is not installed in the project's Python environment"
      : undefined,
    coverageOffReason: (projectRoot) => pythonFor(projectRoot) && !pythonFor(projectRoot)!.coverage
      ? "pytest: install the coverage package in the project's Python environment (pip install coverage)"
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
