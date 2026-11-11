/**
 * The Angular {@link FrameworkServices} bundle: Vitest run through Angular's
 * unit-test builder (`ng test`). Results, live events and coverage are read
 * as for Vitest; no execution trace yet (the builder compiles the tests
 * itself, so the Vite trace plugin does not apply).
 */
import * as path from 'path';
import { AngularAdapter as AngularRunnerAdapter, CommandRunner, FRAMEWORK_IDS, vitestCoverageInstalled } from '@live-test-runner/runner';
import { FrameworkServices } from './FrameworkServices';
import { AngularAdapter } from './AngularAdapter';
import { VitestBatchRunner } from '../session/VitestBatchRunner';
import { AngularBatchRunner } from '../session/AngularBatchRunner';
import { IProjectConfig } from '../session/IProjectConfig';
import { CoverageStore } from '../coverage/CoverageStore';
import { CoverageScope } from '../coverage/coverageScope';

/** angular.json holds the test setup; no config file to resolve. */
class AngularProjectConfig implements IProjectConfig {
  async get(): Promise<string | undefined> { return undefined; }
  /**
   * `ng test --coverage` lists only the files the tests load (Vitest 4+ adds
   * files no test loads only for an include list: `coverageInclude`, which
   * the provider's own untested pass then counts). So no source scan, and
   * every file the builder's report lists counts (its `coverageInclude` /
   * `coverageExclude` already applied; `app.config.ts` is the app's code, not
   * a tool config): only files outside the project or in node_modules are left out.
   */
  async coverageScope(projectRoot: string): Promise<CoverageScope> {
    return {
      source: 'Angular (ng test --coverage)',
      includesUntouched: false,
      isDefault: false,
      counts: (fp) => {
        const rel = path.relative(projectRoot, fp);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !/(^|[\\/])node_modules([\\/]|$)/.test(rel);
      },
    };
  }
  /** Component templates (`templateUrl`): saving one reruns its component's tests. */
  async sourceExtensions(): Promise<string[]> { return ['html']; }
  reset(): void { /* nothing cached */ }
}

export function createAngularServices(options: {
  sessionDir: string;
  coverageStore: CoverageStore;
  rawLog: (msg: string) => void;
}): FrameworkServices {
  const { sessionDir, rawLog, coverageStore } = options;
  const runnerAdapter = new AngularRunnerAdapter();
  const projectConfig = new AngularProjectConfig();
  const newRunner = (logger: (msg: string) => void) =>
    runnerAdapter.createRunner({ logger, tmpDir: sessionDir }) as CommandRunner;
  const batchRunner = new AngularBatchRunner(new VitestBatchRunner(newRunner, { store: coverageStore, sessionDir, projectConfig, perTestFile: 'always' }));
  return {
    framework: FRAMEWORK_IDS.angular,
    displayName: 'Angular',
    terms: {
      name: 'Angular',
      config: 'angular.json',
      configRulesShort: 'include / exclude',
      configRules: 'the test target\'s include / exclude',
      listCommand: 'ng test --list-tests',
      relatedCommand: 'the test files that import it',
      batchRun: 'ng test batch',
      plainRun: 'plain ng test',
      fallbackLoss: 'slower',
    },
    features: { trace: false, timeline: false },
    // Each `ng test` builds its files before a test runs (~7 s): 588 files in 3 parallel batches took 41 s
    // in 49-file batches, 18 s in 196-file ones.
    batchPolicy: { maxFilesPerBatch: 200 },
    traceOffReason: () => 'Angular runs without the execution trace for now',
    coverageOffReason: (projectRoot) => vitestCoverageInstalled(projectRoot, 'v8') || vitestCoverageInstalled(projectRoot, 'istanbul')
      ? undefined
      : 'Angular: install @vitest/coverage-v8 in the project (npm i -D @vitest/coverage-v8), as Angular\'s testing guide says',
    adapter: new AngularAdapter(sessionDir),
    projectConfig,
    batchRunner,
    instrumentedRunner: undefined,
    createSessionRunner: () => newRunner(rawLog),
    settingsFingerprint: () => 'angular',
    configFileNames: ['angular.json'],
    // angular.json, and the test tsconfig it points at by default.
    isConfigFile: async (filePath, projectRoot) =>
      path.dirname(filePath) === projectRoot && /^(angular\.json|tsconfig\.spec\.json)$/.test(path.basename(filePath)),
  };
}
