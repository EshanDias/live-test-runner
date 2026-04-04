// ── Public API ────────────────────────────────────────────────────────────────

// Core interface — the extension layer depends only on this
export { TestRunner } from './TestRunner';

// Shared result types
export {
  Framework,
  PackageManager,
  TestResult,
  JestTestCaseResult,
  JestConsoleEntry,
  JestFileResult,
  JestJsonResult,
} from './types';

// Concrete runner
export { JestRunner } from './JestRunner';

// Framework layer — exposed so callers can detect framework without running
export { FrameworkDetector } from './framework/FrameworkDetector';
export { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
export { JestAdapter } from './framework/adapters/JestAdapter';
export { CRAAdapter } from './framework/adapters/CRAAdapter';
export { ViteAdapter, UnsupportedFrameworkError } from './framework/adapters/ViteAdapter';

// Lower-level layers — exposed for testing and advanced usage
export { BinaryResolver } from './resolution/BinaryResolver';
export { Executor } from './execution/Executor';
export { ResultParser } from './parsing/ResultParser';
