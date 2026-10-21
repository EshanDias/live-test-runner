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
export { CommandRunner, RunRequest } from './CommandRunner';
export { JestRunner, toJestPathArg } from './JestRunner';
export { VitestRunner, toVitestNamePattern, toVitestPathArg } from './VitestRunner';

// Framework layer — exposed so callers can detect framework without running
export { FrameworkDetector, DetectionResult } from './framework/FrameworkDetector';
export { FrameworkRegistry, ADAPTER_PRIORITIES } from './framework/FrameworkRegistry';
export { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
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
export { toInputConfig, pickGlobalConfig, testScriptJestArgs } from './framework/jestConfig';
export { testScriptVitestArgs, VitestScriptArgs } from './framework/vitestConfig';
export { vitestProjects, VitestProjectInfo } from './framework/vitestProjects';
export { refusingAdapter } from './framework/refusingAdapter';

// Lower-level layers — exposed for testing and advanced usage
export { BinaryResolver, nodeRuntime, nodeRuntimeVersion, NodeRuntime } from './resolution/BinaryResolver';
export { parseVersion, compareVersions, satisfies } from './utils/semver';
export { registerProjectRoot, toRunnerPath, fromRunnerPath, toJestPath, fromJestPath } from './resolution/RunnerPaths';
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
