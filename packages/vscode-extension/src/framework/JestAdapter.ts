import * as vscode from 'vscode';
import {
  JestRunner,
  FileRunResult,
  ConsoleEntry,
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

import { nameToPattern } from '../session/SessionManager';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

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
    } catch {
      return false;
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async discoverTests(
    projectRoot: string,
    log: (msg: string) => void,
  ): Promise<string[]> {
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

  isSnapshotError(message: string): boolean {
    // Jest snapshot mismatch detection:
    // 1. Snapshot name: `...`
    // 2. - Snapshot
    // 3. + Received
    return (
      message.includes('Snapshot name: \x60') ||
      (message.includes('- Snapshot') && message.includes('+ Received'))
    );
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
    if (!fileResult) {
      return 'failed';
    }
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
    // Determine if this is a suite-level rerun (no individual test node)
    const isSuiteRun = opts?.nodeId
      ? store.getNode(opts.nodeId)?.type === 'suite'
      : false;
    const jsonResult = await runner.runTestCaseJson(
      filePath,
      fullName,
      isSuiteRun,
      !!opts?.updateSnapshots,
    );
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
    if (testFullName) {
      args.push('--testNamePattern', escapeRegex(testFullName));
    }
    args.push('--runInBand', '--no-coverage');
    return {
      type: 'node',
      request: 'launch',
      name: 'Debug Jest test',
      program: '${workspaceFolder}/node_modules/.bin/jest',
      args,
      cwd: projectRoot,
      console: 'integratedTerminal',
      skipFiles: ['<node_internals>/**'],
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _createRunner(
    projectRoot: string,
    log: (msg: string) => void,
  ): JestRunner {
    const cmd = this._getCommand();
    const runner = new JestRunner(cmd, log, this._tmpDir);
    runner.setProjectRoot(projectRoot);
    return runner;
  }

  private _getCommand(): string {
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    if (cfg.get<string>('runMode') === 'npm') {
      return 'npm test --';
    }
    return cfg.get<string>('jestCommand') || '';
  }

  private _applyFileResult(
    store: ResultStore,
    filePath: string,
    fileResult: FileRunResult,
    opts?: RerunOptions,
  ): void {
    // Track which node IDs we've applied so we can scope output correctly.
    let lastTouchedTestNodeId: string | undefined;
    let touchedNodeIds = new Set<string>();

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

      // Create/update the test node
      const testNodeId = makeNodeId(filePath, ancsForId, tc.title);

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

      const status: TestStatus =
        tc.status === 'passed'
          ? 'passed'
          : tc.status === 'failed'
            ? 'failed'
            : tc.status === 'skipped'
              ? 'skipped'
              : 'pending';

      const isSnapshot = tc.failureMessages.some((m) => this.isSnapshotError(m));

      store.nodeResult(
        testNodeId,
        status,
        tc.duration,
        (tc.failureMessages ?? []).map(stripAnsi),
        isSnapshot,
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
