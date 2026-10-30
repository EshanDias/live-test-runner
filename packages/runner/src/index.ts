// ── Public API ────────────────────────────────────────────────────────────────

export { LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR } from './constants';

// Core interface — the extension layer depends only on this
export { TestRunner, RunnerOptions } from './TestRunner';

// Shared result types (canonical names)
export {
  Framework,
  FrameworkId,
  FrameworkCapabilities,
  FRAMEWORK_IDS,
  PackageManager,
  TestResult,
  RunResult,
  FileRunResult,
  TestCaseRunResult,
  ConsoleEntry,
} from './types';

// Backward-compatible type aliases — kept so existing imports don't break
export {
  JestJsonResult,
  JestFileResult,
  JestTestCaseResult,
  JestConsoleEntry,
} from './types';

// Runners: the generic command-line runner and the Jest one built on it
export { CommandRunner, RunRequest, TestFileList } from './CommandRunner';
export { JestRunner, toJestPathArg } from './JestRunner';
export { VitestRunner, toVitestNamePattern, toVitestPathArg } from './VitestRunner';
export { PytestRunner, toPytestPathArg, PytestListing, PYTEST_EVENTS_ENV, PYTEST_LIST_ENV, PYTEST_COVERAGE_ENV, pytestExitReason } from './PytestRunner';
export { PytestAdapter } from './framework/adapters/PytestAdapter';
export {
  PythonInfo,
  MIN_PYTHON,
  MIN_PYTEST,
  probePython,
  unsupportedReason,
  describePython,
  setPythonFor,
  pythonFor,
} from './framework/pytest/python';
export {
  PytestConfigFile,
  PytestSettings,
  PYTEST_CONFIG_FILES,
  DEFAULT_PYTHON_FILES,
  findPytestConfig,
  pytestSettings,
  isPytestProject,
  parseIni,
  parseTomlTables,
  splitArgs,
} from './framework/pytest/pytestConfig';
export { nodeIdFor, nodeIdsFor, isTemplateName } from './framework/pytest/pytestNodeIds';
export { LTR_PYTEST_SOURCE } from './framework/pytest/ltrPytestSource';

// Framework layer — exposed so callers can detect framework without running
export { FrameworkDetector, DetectionResult } from './framework/FrameworkDetector';
export { FrameworkRegistry, ADAPTER_PRIORITIES } from './framework/FrameworkRegistry';
export { FrameworkAdapter, FrameworkFamily } from './framework/adapters/FrameworkAdapter';
export { JestAdapter, JEST_CAPABILITIES } from './framework/adapters/JestAdapter';
export { CRAAdapter } from './framework/adapters/CRAAdapter';
export {
  VitestAdapter,
  VitestInstall,
  vitestCapabilities,
  VITEST_BASELINE_MAJOR,
  VITEST_CONFIG_FILES,
  VITE_CONFIG_FILES,
} from './framework/adapters/VitestAdapter';
export { UnsupportedFrameworkError } from './framework/UnsupportedFrameworkError';
export { toInputConfig, pickGlobalConfig, testScriptJestArgs, testScriptNodeOptions, jestNodeEnv, npmrcNodeOptions, jestEsmHint } from './framework/jestConfig';
export { testScriptVitestArgs, VitestScriptArgs } from './framework/vitestConfig';
export { vitestProjects, vitestConfigInfo, vitestCoverageInstalled, VitestProjectInfo, VitestConfigInfo } from './framework/vitestProjects';
export {
  VITEST_EVENTS_ENV,
  VitestEvent,
  VitestLiveEvent,
  VitestLogEvent,
  VitestErrorEvent,
  applyVitestEvents,
  liveFileResult,
  fileKey as vitestFileKey,
} from './framework/vitestReporter';
export { refusingAdapter } from './framework/refusingAdapter';
export {
  RoutedFramework,
  ProjectFrameworks,
  projectFrameworks,
  frameworkHint,
  FrameworkRule,
  FrameworkRuleSetting,
  globToRegExp,
  parseFrameworkRules,
  matchFrameworkRule,
  AssignmentRule,
  FrameworkAssignment,
  AssignInput,
  AssignOutput,
  assignFrameworks,
  allowFrameworkAt,
  isFrameworkAllowedAt,
} from './framework/frameworkRouting';
export {
  DetectedProject,
  findTestProjects,
  projectsInFolder,
  hasOwnTestConfig,
  testFrameworkOf,
  workspaceGlobs,
  pnpmWorkspacePackages,
  expandWorkspaceGlobs,
  isInside,
  pyprojectName,
} from './framework/projectDiscovery';

// Lower-level layers — exposed for testing and advanced usage
export { BinaryResolver, nodeRuntime, nodeRuntimeVersion, NodeRuntime, resolvePackageDir } from './resolution/BinaryResolver';
export { viteEntryFor, vitestDirFor } from './framework/vitestTrace';
export { parseVersion, compareVersions, satisfies } from './utils/semver';
export { registerProjectRoot, toRunnerPath, fromRunnerPath, toSpawnPath, toJestPath, fromJestPath } from './resolution/RunnerPaths';
export { Executor, tail } from './execution/Executor';

// Logging — the extension installs a sink so runner/core logs reach its log channel
export {
  createLogger,
  setLogSink,
  stripAnsi,
  describeError,
  LogLevel,
  LogSink,
  ScopedLogger,
} from './utils/logger';
export { ResultParser } from './parsing/ResultParser';
export {
  parseVitestResult,
  VITEST_HOOK_FAILURE,
  VITEST_FILE_FAILURE,
  VITEST_UNHANDLED_ERROR,
} from './parsing/VitestResultParser';
export { emptyRunResult, mergeRunResults } from './parsing/runResults';
export { mergeFileResults, mergeByFile } from './parsing/mergeFileResults';
