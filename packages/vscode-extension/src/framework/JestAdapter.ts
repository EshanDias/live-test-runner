import * as vscode from 'vscode';
import { JestRunner, JestFileResult } from '@live-test-runner/runner';
import { TestSession } from '@live-test-runner/core';
import { IFrameworkAdapter, RerunOptions } from './IFrameworkAdapter';
import {
  ResultStore,
  TestStatus,
  OutputLevel,
  OutputLine,
  ScopedOutput,
} from '../store/ResultStore';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * JestAdapter — all Jest-specific logic in one place.
 *
 * Reads liveTestRunner.* VS Code config for jest command, run mode, and file patterns.
 * Delegates actual process execution to JestRunner (packages/runner), which handles
 * framework detection, binary resolution, and JSON output parsing.
 *
 * To add Vitest support: create VitestAdapter.ts implementing IFrameworkAdapter,
 * then swap `new JestAdapter()` in extension.ts (or add auto-detection logic there).
 */
export class JestAdapter implements IFrameworkAdapter {

  // ── Detection ──────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
      return (
        !!pkg.dependencies?.jest ||
        !!pkg.devDependencies?.jest ||
        !!pkg.scripts?.test?.includes('jest')
      );
    } catch {
      return false;
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async discoverTests(projectRoot: string, log: (msg: string) => void): Promise<string[]> {
    const runner = this._createRunner(projectRoot, log);
    return runner.discoverTests(projectRoot);
  }

  // ── File identification ────────────────────────────────────────────────────

  getFileGlob(): string {
    const patterns = vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<string[]>('testFilePatterns') ?? ['**/*.test.*', '**/*.spec.*'];
    return `{${patterns.join(',')}}`;
  }

  isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.[jt]sx?$/.test(filePath);
  }

  // ── Run operations ─────────────────────────────────────────────────────────

  async runFile(
    store: ResultStore,
    filePath: string,
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<'passed' | 'failed'> {
    const runner = this._createRunner(projectRoot, log);
    const jsonResult = await runner.runTestFileJson(filePath);
    const fileResult = jsonResult.fileResults[0];
    if (!fileResult) { return 'failed'; }
    this._applyFileResult(store, filePath, fileResult);
    return fileResult.status === 'passed' ? 'passed' : 'failed';
  }

  async runTestCase(
    store: ResultStore,
    filePath: string,
    fullName: string,
    projectRoot: string,
    log: (msg: string) => void,
    opts?: RerunOptions,
  ): Promise<void> {
    const runner = this._createRunner(projectRoot, log);
    const jsonResult = await runner.runTestCaseJson(filePath, fullName);
    const fileResult = jsonResult.fileResults[0];
    if (fileResult) {
      this._applyFileResult(store, filePath, fileResult, opts);
    }
  }

  // ── Coverage ───────────────────────────────────────────────────────────────

  getAffectedTests(session: TestSession, changedFile: string): string[] {
    return Array.from(session.getCoverageMap().getAffectedTests(changedFile));
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
  ): vscode.DebugConfiguration {
    const args: string[] = [filePath];
    if (testFullName) { args.push('--testNamePattern', escapeRegex(testFullName)); }
    args.push('--runInBand', '--no-coverage');
    return {
      type:      'node',
      request:   'launch',
      name:      'Debug Jest test',
      program:   '${workspaceFolder}/node_modules/.bin/jest',
      args,
      cwd:       projectRoot,
      console:   'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _createRunner(projectRoot: string, log: (msg: string) => void): JestRunner {
    const cmd    = this._getCommand();
    const runner = new JestRunner(cmd, log);
    runner.setProjectRoot(projectRoot);
    return runner;
  }

  private _getCommand(): string {
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    if (cfg.get<string>('runMode') === 'npm') { return 'npm test --'; }
    return cfg.get<string>('jestCommand') || '';
  }

  private _applyFileResult(
    store: ResultStore,
    filePath: string,
    fileResult: JestFileResult,
    opts?: RerunOptions,
  ): void {
    const touchedSuiteIds = new Set<string>();
    let touchedTestId: string | undefined;

    for (const tc of fileResult.testCases) {
      const suiteKey = tc.ancestorTitles.join(' > ') || '(root)';
      const suiteId  = `${filePath}::${suiteKey}`;

      if (opts?.suiteId && suiteId !== opts.suiteId) { continue; }
      if (!store.getSuite(filePath, suiteId)) { store.suiteStarted(filePath, suiteId, suiteKey); }
      touchedSuiteIds.add(suiteId);

      const testId = `${suiteId}::${tc.fullName || tc.title}`;
      if (opts?.testId && testId !== opts.testId) { continue; }

      store.testStarted(filePath, suiteId, testId, tc.title, tc.fullName || tc.title, tc.location?.line);
      touchedTestId = testId;

      const status: TestStatus =
        tc.status === 'passed'  ? 'passed'  :
        tc.status === 'failed'  ? 'failed'  :
        tc.status === 'skipped' ? 'skipped' : 'pending';

      store.testResult(filePath, suiteId, testId, status, tc.duration, (tc.failureMessages ?? []).map(stripAnsi));
    }

    // Roll up suite statuses
    const file = store.getFile(filePath);
    if (file) {
      for (const suite of file.suites.values()) {
        const tests       = Array.from(suite.tests.values());
        const suiteStatus = tests.some((t) => t.status === 'failed') ? 'failed' : 'passed' as TestStatus;
        const suiteDur    = tests.reduce((acc, t) => acc + (t.duration ?? 0), 0);
        store.suiteResult(filePath, suite.suiteId, suiteStatus, suiteDur);
      }
    }

    // Store console output at the appropriate scope
    const consoleLines = fileResult.consoleOutput?.length ? fileResult.consoleOutput : [];
    const now = Date.now();

    if (opts?.testId && touchedTestId) {
      const suiteId = [...touchedSuiteIds][0];
      if (suiteId) {
        const output: ScopedOutput = { lines: this._buildOutputLines(consoleLines, now), capturedAt: now };
        store.setSuiteOutput(filePath, suiteId, output);
        store.setTestOutput(filePath, suiteId, touchedTestId, output);
      }
    } else if (opts?.suiteId && touchedSuiteIds.size > 0) {
      const suiteId = [...touchedSuiteIds][0];
      if (suiteId) {
        store.setSuiteOutput(filePath, suiteId, { lines: this._buildOutputLines(consoleLines, now), capturedAt: now });
      }
    } else {
      store.setFileOutput(filePath, { lines: this._buildOutputLines(consoleLines, now), capturedAt: now });
    }

    store.fileResult(filePath, fileResult.status === 'passed' ? 'passed' : 'failed', fileResult.duration);

    // Populate LineMap (only clear on full-file run to preserve other tests' entries)
    if (!opts?.suiteId && !opts?.testId) { store.clearLineMap(filePath); }
    for (const tc of fileResult.testCases) {
      if (tc.location?.line == null) { continue; }
      const suiteKey = tc.ancestorTitles.join(' > ') || '(root)';
      const suiteId  = `${filePath}::${suiteKey}`;
      const testId   = `${suiteId}::${tc.fullName || tc.title}`;
      store.setLineEntry(filePath, tc.location.line, { testId, suiteId, fileId: filePath });
    }
  }

  private _buildOutputLines(
    entries: JestFileResult['consoleOutput'],
    timestamp: number,
  ): OutputLine[] {
    return entries.map((entry) => ({
      text:      stripAnsi(entry.message),
      level:     (
        entry.type === 'warn'  ? 'warn'  :
        entry.type === 'error' ? 'error' :
        entry.type === 'log'   ? 'log'   : 'info'
      ) as OutputLevel,
      timestamp,
    }));
  }
}
