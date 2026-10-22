import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { FileRunResult } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';

export interface RerunOptions {
  /** Narrow result application to a specific node (partial rerun) */
  nodeId?: string;
  /**
   * When set, only update tests whose fullName is in this set.
   * Used for pattern-based runs where Jest marks non-matching tests as "skipped"
   * even though they were never intended to run.
   */
  fullNames?: Set<string>;
}

/**
 * IFrameworkAdapter — everything that differs between Jest, Vitest, Mocha, etc.
 *
 * The extension orchestrates the run lifecycle (concurrency, status bar, observer
 * notifications) and delegates all framework-specific concerns to an adapter.
 * Adding a new framework = implementing this interface, zero changes to extension.ts.
 */
export interface IFrameworkAdapter {
  /** Returns true if this adapter can handle the given project root. */
  detect(projectRoot: string): Promise<boolean>;

  /** Discover all test file paths in the project. */
  discoverTests(projectRoot: string, log: (msg: string) => void): Promise<string[]>;

  /**
   * {@link discoverTests} plus the framework's own grouping of the files
   * (Vitest: `test.projects` names, D12). Optional — without it there are no groups.
   */
  listTestFiles?(projectRoot: string, log: (msg: string) => void): Promise<{ files: string[]; groups?: Record<string, string> }>;

  /** Glob pattern for watching test files on save (e.g. `{**\/*.test.*,**\/*.spec.*}`). */
  getFileGlob(): string;

  /** Quick synchronous check used by the on-save handler. */
  isTestFile(filePath: string): boolean;

  /**
   * Run a full test file. Writes results into the store and returns pass/fail.
   * Used for scoped single-file reruns; the batch path uses the batch runner (IBatchRunner).
   */
  runFile(
    store: ResultStore,
    filePath: string,
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<'passed' | 'failed'>;

  /**
   * Apply a parsed FileRunResult (from liveReporter) into the store.
   * Called by the batch runner (JestBatchRunner) after the combined test+trace batch run.
   */
  applyFileResult(
    store: ResultStore,
    filePath: string,
    fileResult: FileRunResult,
    opts?: RerunOptions,
  ): void;

  /**
   * Run a single named test case (partial rerun from webview or CodeLens).
   * Writes results into the store at the appropriate scope.
   * @returns false when no result came back (the caller clears the spinners).
   */
  runTestCase(
    store: ResultStore,
    filePath: string,
    fullName: string,
    projectRoot: string,
    log: (msg: string) => void,
    opts?: RerunOptions,
  ): Promise<boolean>;

  /**
   * Given a session (which holds the coverage map), return the set of test
   * file paths affected by a change to the given source file.
   */
  getAffectedTests(session: TestSession, changedFile: string): string[];

  /**
   * Use the framework's own static-analysis fallback (e.g. jest --findRelatedTests)
   * to find and run tests related to the changed source file.
   * Called when no trace data exists for the changed file.
   */
  runRelatedTests(
    store: ResultStore,
    sourceFilePath: string,
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<string[]>;

  /**
   * VS Code debug launch configuration for running a test (or, with
   * `isSuite`, every test in a suite) under the debugger.
   */
  getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite?: boolean,
  ): Promise<vscode.DebugConfiguration>;
}
