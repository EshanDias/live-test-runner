import * as path from 'path';
import * as vscode from 'vscode';
import {
  JestRunner,
  FileRunResult,
  ConsoleEntry,
  BinaryResolver,
  FrameworkDetector,
  toJestPathArg,
} from '@live-test-runner/runner';
import { TestSession } from '@live-test-runner/core';
import { IFrameworkAdapter, RerunOptions } from './IFrameworkAdapter';
import {
  ResultStore,
  TestStatus,
  OutputLevel,
  OutputLine,
  ScopedOutput,
  makeNodeId,
} from '../store/ResultStore';
import { nameToPattern } from '../utils/testNames';
import { logger } from '../utils/logger';

const log = logger.scope('Jest');

/** A plain (uninstrumented) single-file run may take this many hang limits in total. */
export const PLAIN_RUN_HANG_FACTOR = 3;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
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
  constructor(private readonly _tmpDir: string) {}

  // ── Detection ──────────────────────────────────────────────────────────────

  async detect(projectRoot: string): Promise<boolean> {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
      );
      return (
        !!pkg.dependencies?.jest ||
        !!pkg.devDependencies?.jest ||
        !!pkg.scripts?.test?.includes('jest')
      );
    } catch (err) {
      log.warn(`Could not read ${projectRoot}/package.json — assuming this is not a Jest project`, err);
      return false;
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async discoverTests(
    projectRoot: string,
    rawLog: (msg: string) => void,
  ): Promise<string[]> {
    const runner = this._createRunner(projectRoot, rawLog);
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
    // Same extensions as discovery (.mjs / .cjs included — BUG-17).
    return /\.(test|spec)\.(c|m)?[jt]sx?$/i.test(filePath);
  }

  // ── Run operations ─────────────────────────────────────────────────────────

  async runFile(
    store: ResultStore,
    filePath: string,
    projectRoot: string,
    rawLog: (msg: string) => void,
  ): Promise<'passed' | 'failed'> {
    const runner = this._createRunner(projectRoot, rawLog);
    let jsonResult: Awaited<ReturnType<typeof runner.runTestFileJson>>;
    try {
      jsonResult = await runner.runTestFileJson(filePath);
    } catch (err) {
      log.error(`Could not run ${filePath}`, err);
      return 'failed';
    }
    const fileResult = jsonResult.fileResults[0];
    if (!fileResult) {
      log.warn(`Jest returned no result for ${filePath} — marking it failed`);
      return 'failed';
    }
    try {
      this._applyFileResult(store, filePath, fileResult);
    } catch (err) {
      log.error(`Could not apply results for ${filePath}`, err);
    }
    return fileResult.status === 'passed' ? 'passed' : 'failed';
  }

  async runTestCase(
    store: ResultStore,
    filePath: string,
    fullName: string,
    projectRoot: string,
    rawLog: (msg: string) => void,
    opts?: RerunOptions,
  ): Promise<boolean> {
    log.debug(`Scoped run in ${filePath} — pattern ${fullName}`);
    const runner = this._createRunner(projectRoot, rawLog);
    // Determine if this is a suite-level rerun (no individual test node)
    const isSuiteRun = opts?.nodeId
      ? store.getNode(opts.nodeId)?.type === 'suite'
      : false;
    let jsonResult: Awaited<ReturnType<typeof runner.runTestCaseJson>>;
    try {
      jsonResult = await runner.runTestCaseJson(filePath, fullName, isSuiteRun);
    } catch (err) {
      log.error(`Could not run pattern ${fullName} in ${filePath}`, err);
      return false;
    }
    const fileResult = jsonResult.fileResults[0];
    if (!fileResult) {
      log.warn(`Jest returned no result for ${filePath} (pattern ${fullName}) — the test name may no longer match`);
      return false;
    }
    try {
      this._applyFileResult(store, filePath, fileResult, opts);
      return true;
    } catch (err) {
      log.error(`Could not apply scoped results for ${filePath}`, err);
      return false;
    }
  }

  // ── Coverage / affected tests ──────────────────────────────────────────────

  getAffectedTests(session: TestSession, changedFile: string): string[] {
    return Array.from(session.getCoverageMap().getAffectedTests(changedFile));
  }

  async runRelatedTests(
    store: ResultStore,
    sourceFilePath: string,
    projectRoot: string,
    rawLog: (msg: string) => void,
  ): Promise<string[]> {
    const runner = this._createRunner(projectRoot, rawLog);
    let jsonResult: Awaited<ReturnType<typeof runner.runRelatedTestsJson>>;
    try {
      jsonResult = await runner.runRelatedTestsJson(sourceFilePath);
    } catch (err) {
      log.error(`jest --findRelatedTests failed for ${sourceFilePath}`, err);
      return [];
    }
    const affectedPaths: string[] = [];
    for (const fileResult of jsonResult.fileResults) {
      // Jest reports its own spelling of the path (e.g. C:\ vs c:\) — use the
      // store's key, or the result would create a duplicate file entry.
      const fileId = store.findFileKey(fileResult.testFilePath) ?? fileResult.testFilePath;
      try {
        store.markFileRunning(fileId);
        this._applyFileResult(store, fileId, fileResult);
        affectedPaths.push(fileId);
      } catch (err) {
        log.error(`Could not apply results for ${fileId}`, err);
      }
    }
    return affectedPaths;
  }

  // ── Debug ──────────────────────────────────────────────────────────────────

  async getDebugConfig(
    projectRoot: string,
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration> {
    // Jest's JS entry point, resolved from the project root (not the workspace
    // folder) — `.bin/jest` is a shell script on Windows and cannot be a program.
    const framework = new FrameworkDetector().detect(projectRoot);
    const isCra = framework.framework === 'cra';
    const program =
      (isCra ? BinaryResolver.resolveCraJestEntry(projectRoot) : BinaryResolver.resolveJestEntry(projectRoot))
      ?? path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');

    const args: string[] = [];
    if (isCra) {
      // CRA keeps its Jest config inside react-scripts — use the extracted copy.
      const config = await framework.resolveConfig(projectRoot);
      if (config) { args.push('--config', config); }
    }
    // --config / --resetMocks … from the project's test script, like npm test.
    args.push(...framework.getExtraArgs(projectRoot));
    args.push('--runTestsByPath', toJestPathArg(filePath));
    if (testFullName) {
      const p = nameToPattern(testFullName);
      args.push('--testNamePattern', isSuite ? `^(?:${p})(?: |$)` : `^(?:${p})$`);
    }
    args.push('--runInBand', '--no-coverage', '--watchAll=false');
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Jest test',
      program,
      args,
      cwd: projectRoot,
      console: 'integratedTerminal',
      env: { NODE_ENV: 'test', BABEL_ENV: 'test' },
      skipFiles: ['<node_internals>/**'],
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _createRunner(
    projectRoot: string,
    rawLog: (msg: string) => void,
  ): JestRunner {
    const cmd = this._getCommand();
    const runner = new JestRunner(cmd, rawLog, this._tmpDir);
    runner.setProjectRoot(projectRoot);
    // Plain runs have no per-test heartbeat, so the limit covers the whole
    // file (load + all tests) and is wider than the per-test hang limit.
    runner.setFileTimeout(PLAIN_RUN_HANG_FACTOR * 1000 * (vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<number>('hangTimeoutSeconds') ?? 300));
    return runner;
  }

  private _getCommand(): string {
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    if (cfg.get<string>('runMode') === 'npm') {
      return 'npm test --';
    }
    return cfg.get<string>('jestCommand') || '';
  }

  applyFileResult(
    store: ResultStore,
    filePath: string,
    fileResult: FileRunResult,
    opts?: RerunOptions,
  ): void {
    this._applyFileResult(store, filePath, fileResult, opts);
  }

  private _applyFileResult(
    store: ResultStore,
    filePath: string,
    fileResult: FileRunResult,
    opts?: RerunOptions,
  ): void {
    // Track which node IDs we've applied so we can scope output correctly.
    let lastTouchedTestNodeId: string | undefined;
    const touchedNodeIds = new Set<string>();
    /** base test id → how many results had it (duplicate full names). */
    const seenTestIds = new Map<string, number>();

    for (const tc of fileResult.testCases) {
      // Build hierarchical suite nodes from ancestorTitles
      const ancestors =
        tc.ancestorTitles.length > 0 ? tc.ancestorTitles : ['(root)'];

      // Ensure all ancestor suite nodes exist
      let parentId: string | null = null;
      const ancsForId: string[] = [];

      for (let i = 0; i < ancestors.length; i++) {
        const title = ancestors[i];

        // 1. Check if current parent contains an isDynamicTemplate child matching this title
        const siblings = parentId
          ? store.getChildren(parentId)
          : store.getFileNodes(filePath).filter((n) => !n.parentId);

        const template = siblings.find(
          (s) =>
            s.isDynamicTemplate &&
            title.match(new RegExp('^' + nameToPattern(s.name) + '$')),
        );

        if (template) {
          parentId = template.id;
          ancsForId.push(template.name);
        }

        const suiteNodeId = makeNodeId(filePath, ancsForId, title);

        // If filtering to a specific node, skip test cases outside the subtree
        if (opts?.nodeId) {
          const targetNode = store.getNode(opts.nodeId);
          if (targetNode) {
            const isInScope =
              suiteNodeId === opts.nodeId ||
              suiteNodeId.startsWith(opts.nodeId + '::') ||
              opts.nodeId.startsWith(suiteNodeId + '::');
            if (i === ancestors.length - 1 && !isInScope) {
              parentId = null;
              break;
            }
          }
        }

        if (opts?.fullNames && !opts.fullNames.has(tc.fullName ?? tc.title)) {
          parentId = null;
          break;
        }

        // Create suite node if it doesn't exist
        const suiteFullName = ancestors.slice(0, i + 1).join(' ');
        store.nodeStarted(
          filePath,
          suiteNodeId,
          parentId,
          'suite',
          title,
          suiteFullName,
        );
        touchedNodeIds.add(suiteNodeId);
        parentId = suiteNodeId;
        ancsForId.push(title);
      }

      if (parentId === null) {
        continue; // Skipped due to filtering
      }

      // Check if the leaf test title matches a dynamic template under the current parent
      const leafSiblings = store.getChildren(parentId);
      const leafTemplate = leafSiblings.find(
        (s) =>
          s.isDynamicTemplate &&
          tc.title.match(new RegExp('^' + nameToPattern(s.name) + '$')),
      );

      if (leafTemplate) {
        parentId = leafTemplate.id;
        ancsForId.push(leafTemplate.name);
      }

      // Create/update the test node. Jest allows several tests with the same
      // full name (e.g. describe.each with a non-interpolated $object); keying
      // them by name collapsed them into one node where the last result won —
      // a failure could be hidden by a later pass. Repeats get their own node.
      const baseTestId = makeNodeId(filePath, ancsForId, tc.title);
      const occurrence = (seenTestIds.get(baseTestId) ?? 0) + 1;
      seenTestIds.set(baseTestId, occurrence);
      const testNodeId = occurrence === 1 ? baseTestId : `${baseTestId}::#${occurrence}`;

      // If we are in a scoped run, only update the store for nodes within that scope.
      // This ensures that non-matching tests reported by Jest ('pending' or 'skipped')
      // do not overwrite your existing results.
      if (opts?.nodeId) {
        // Find if this node is exactly the target or a descendant of the target.
        const inScope =
          testNodeId === opts.nodeId || testNodeId.startsWith(opts.nodeId + '::');
        if (!inScope) {
          continue;
        }
      }

      store.nodeStarted(
        filePath,
        testNodeId,
        parentId,
        'test',
        tc.title,
        tc.fullName || tc.title,
        tc.location?.line,
      );

      // Jest reports test.skip / xit / tests skipped by .only as "pending" and
      // test.todo as "todo". Both ran (as skipped) — never show them as ○
      // "not run yet" (BUG-24).
      const status: TestStatus =
        tc.status === 'passed'
          ? 'passed'
          : tc.status === 'failed'
            ? 'failed'
            : 'skipped';

      store.nodeResult(
        testNodeId,
        status,
        tc.duration,
        (tc.failureMessages ?? []).map(stripAnsi),
      );

      // Bubble up status through parents
      store.bubbleUpStatus(testNodeId);

      touchedNodeIds.add(testNodeId);
      lastTouchedTestNodeId = testNodeId;
    }

    // Store console output at the appropriate scope
    const consoleLines = fileResult.consoleOutput?.length
      ? fileResult.consoleOutput
      : [];
    const now = Date.now();

    const output: ScopedOutput = {
      lines: this._buildOutputLines(consoleLines, now),
      capturedAt: now,
    };

    if (opts?.nodeId && lastTouchedTestNodeId) {
      const targetNode = store.getNode(opts.nodeId);
      if (targetNode?.type === 'test') {
        store.setNodeOutput(lastTouchedTestNodeId, output);
      } else if (targetNode?.type === 'suite') {
        store.setNodeOutput(opts.nodeId, output);
      } else {
        store.setFileOutput(filePath, output);
      }
    } else if (opts?.fullNames) {
      // Pattern rerun of a few tests (smart rerun on save). Jest attributes
      // console output to the file only, so this is the output of just those
      // tests: it must not replace the file's full output (BUG-10). It belongs
      // to a test only when exactly one ran; otherwise it cannot be attributed.
      const ranTests = [...touchedNodeIds].filter((id) => store.getNode(id)?.type === 'test');
      if (ranTests.length === 1) { store.setNodeOutput(ranTests[0], output); }
    } else {
      store.setFileOutput(filePath, output);
    }

    // We no longer set file-level status directly from Jest's file result because
    // it can be misleading during partial/scoped runs. Instead, we rely on the
    // ResultStore bubbling up the aggregate status from the actual test nodes.

    // Remove any nodes that are STILL in the 'running' state.
    // If the file actually executed tests, any stuck 'running' nodes are orphans
    // (either AST placeholders or deleted tests) so we remove them.
    // If it crashed entirely (0 test cases), we'll downgrade them to 'pending'.
    const hadTestCases = fileResult.testCases.length > 0;
    store.cleanupStaleNodes(filePath, hadTestCases, opts?.nodeId);

  }




  private _buildOutputLines(
    entries: ConsoleEntry[],
    timestamp: number,
  ): OutputLine[] {
    return entries.map((entry) => ({
      text: stripAnsi(entry.message),
      level: (entry.type === 'warn'
        ? 'warn'
        : entry.type === 'error'
          ? 'error'
          : entry.type === 'log'
            ? 'log'
            : 'info') as OutputLevel,
      timestamp,
    }));
  }
}
