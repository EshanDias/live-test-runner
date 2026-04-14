import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
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

  /** Glob pattern for watching test files on save (e.g. `{**\/*.test.*,**\/*.spec.*}`). */
  getFileGlob(): string;

  /** Quick synchronous check used by the on-save handler. */
  isTestFile(filePath: string): boolean;

  /**
   * Run a full test file. Writes results into the store and returns pass/fail.
   * Called by the concurrency pool in runFiles().
   */
  runFile(
    store: ResultStore,
    filePath: string,
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<'passed' | 'failed'>;

  /**
   * Run a single named test case (partial rerun from webview or CodeLens).
   * Writes results into the store at the appropriate scope.
   */
  runTestCase(
    store: ResultStore,
    filePath: string,
    fullName: string,
    projectRoot: string,
    log: (msg: string) => void,
    opts?: RerunOptions,
  ): Promise<void>;

  /**
   * Given a session (which holds the coverage map), return the set of test
   * file paths affected by a change to the given source file.
   */
  getAffectedTests(session: TestSession, changedFile: string): string[];

  /** VS Code debug launch configuration for running a test under the debugger. */
  getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
  ): vscode.DebugConfiguration;
}
