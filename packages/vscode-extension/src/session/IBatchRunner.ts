/**
 * IBatchRunner — runs a batch of test files in one framework process and
 * streams per-file results back to the caller (SessionManager).
 *
 * One implementation per framework: Jest's is {@link JestBatchRunner}
 * (test results + execution trace + coverage in one instrumented pass).
 * SessionManager only sees this interface.
 */
import { FileRunResult } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';

export interface BatchRunOptions {
  filePaths: string[];
  projectRoot: string;
  traceStore: ExecutionTraceStore;
  store: ResultStore;
  applyFileResult: (filePath: string, fileResult: FileRunResult) => void;
  onFileDone: (filePath: string, status: 'passed' | 'failed') => void;
  /**
   * Another project of the same framework (e.g. a Jest project) reported a
   * file already done in this batch; its merged result was applied.
   * `wasStatus` is what onFileDone reported.
   */
  onFileUpdated?: (filePath: string, status: 'passed' | 'failed', wasStatus: 'passed' | 'failed') => void;
  /** The framework started executing a file (files queued in the batch are not running yet). */
  onFileStart?: (filePath: string) => void;
  /** A file ran longer than hangTimeoutMs; the batch is then stopped and its unfinished files come back as missing. */
  onFileTimedOut?: (filePath: string, seconds: number) => void;
  /** 0 disables the hang timeout. */
  hangTimeoutMs?: number;
  /** Sink for raw test-runner output (the "Test Output" channel). */
  log?: (msg: string) => void;
}

/** A run of the tests that depend on changed source files — the framework finds them (e.g. `vitest related`). */
export interface RelatedRunOptions extends Omit<BatchRunOptions, 'filePaths'> {
  sourceFiles: string[];
}

export interface IBatchRunner {
  /**
   * Run a batch. Calls applyFileResult / onFileDone per file as results
   * arrive and returns the files that produced no result (crashed
   * mid-batch). Result paths are always the caller's own keys (`filePaths`).
   */
  runFiles(options: BatchRunOptions): Promise<{ missing: string[] }>;

  /**
   * Optional: run the tests related to `sourceFiles` in one process, streamed
   * like runFiles (onFileStart before a file's result; coverage measured).
   * Returns the test files that ran and those that started without a result.
   * Without it, SessionManager uses the adapter's plain related run.
   */
  runRelated?(options: RelatedRunOptions): Promise<{ ran: string[]; missing: string[] }>;

  /** Stop every running batch; results from batches started before this are dropped. Final until reset(). */
  kill(): void;

  /** Allow runs again after kill() (a new session). */
  reset(): void;
}
