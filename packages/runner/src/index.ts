// ── Public API ────────────────────────────────────────────────────────────────

export { LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR } from './constants';

// Core interface — the extension layer depends only on this
export { TestRunner } from './TestRunner';

// Shared result types (canonical names)
export {
  Framework,
  FrameworkId,
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

// Concrete runner
export { JestRunner, toJestPathArg } from './JestRunner';

// Framework layer — exposed so callers can detect framework without running
export { FrameworkDetector } from './framework/FrameworkDetector';
export { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
export { JestAdapter } from './framework/adapters/JestAdapter';
export { CRAAdapter } from './framework/adapters/CRAAdapter';
export { ViteAdapter, UnsupportedFrameworkError } from './framework/adapters/ViteAdapter';
export { toInputConfig, pickGlobalConfig, testScriptJestArgs } from './framework/jestConfig';

// Lower-level layers — exposed for testing and advanced usage
export { BinaryResolver, nodeRuntime, NodeRuntime } from './resolution/BinaryResolver';
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
export { mergeFileResults, mergeByFile } from './parsing/mergeFileResults';
