/**
 * The Jest {@link FrameworkServices} bundle (plain Jest and Create React App).
 * The only place outside the Jest classes themselves that builds them.
 */
import { FRAMEWORK_IDS, JestAdapter as JestRunnerAdapter } from '@live-test-runner/runner';
import { CoverageStore } from '../coverage/CoverageStore';
import { FrameworkServices } from './FrameworkServices';
import { JestAdapter, jestCommandSetting } from './JestAdapter';
import { JestProjectConfig } from '../session/JestProjectConfig';
import { JestBatchRunner } from '../session/JestBatchRunner';
import { JestInstrumentedRunner } from '../timeline/JestInstrumentedRunner';

export function createJestServices(options: {
  /** The window's session folder (temp configs, results, traces). */
  sessionDir: string;
  coverageStore: CoverageStore;
  /** Sink for raw Jest output (the "Test Output" channel). */
  rawLog: (msg: string) => void;
}): FrameworkServices {
  const { sessionDir, coverageStore, rawLog } = options;
  // The project's Jest config as Jest resolves it — shared by session runs and the timeline.
  const projectConfig = new JestProjectConfig(sessionDir, rawLog);
  return {
    framework: FRAMEWORK_IDS.jest,
    adapter: new JestAdapter(sessionDir),
    projectConfig,
    batchRunner: new JestBatchRunner(sessionDir, coverageStore, projectConfig),
    instrumentedRunner: new JestInstrumentedRunner(sessionDir, rawLog, projectConfig),
    createSessionRunner: () =>
      new JestRunnerAdapter().createRunner({ command: jestCommandSetting(), logger: rawLog, tmpDir: sessionDir }),
  };
}
