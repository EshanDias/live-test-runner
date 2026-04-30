import * as os from 'os';
import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver } from '../IResultObserver';
import { IFrameworkAdapter } from '../framework/IFrameworkAdapter';
import { DecorationManager } from '../editor/DecorationManager';
import { ResultsView } from '../views/ResultsView';
import { TestDiscoveryService } from './TestDiscoveryService';
import { SessionTraceRunner } from './SessionTraceRunner';
import { CoverageStore } from '../coverage/CoverageStore';
import { SourceCounter } from '../coverage/SourceCounter';
import { logger } from '../utils/logger';

const FILE = 'SessionManager.ts';

/**
 * Convert a test full-name to a regex pattern suitable for --testNamePattern.
 * '…' and '<dynamic>' placeholders (from template-literal test discovery) are
 * expanded to '.*' so they match the real names Jest emits at runtime.
 */
export function nameToPattern(name: string): string {
  const escLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Expand '…', '<dynamic>', and Jest's % placeholders (%s, %d, %i, etc.) into wildcard matching
  return name
    .split(/…|<dynamic>|%[sdifjo#%]/)
    .map(escLiteral)
    .join('.*');
}

/**
 * SessionManager — owns the test session lifecycle and all run execution.
 *
 * Responsibilities:
 *  - Start / stop a TestSession
 *  - Discover test files on startup
 *  - Run files (concurrency pool)
 *  - Handle on-save reruns
 *  - Handle scoped reruns (file / suite / test)
 *  - Maintain and update the status bar
 *
 * Everything framework-specific is delegated to the IFrameworkAdapter.
 * Everything UI-specific is delegated to the observer list.
 */
export class SessionManager {
  private _session: TestSession | undefined;
  private readonly _traceRunner: SessionTraceRunner;
  private readonly _saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly _adapter: IFrameworkAdapter,
    private readonly _store: ResultStore,
    private readonly _traceStore: ExecutionTraceStore,
    private readonly _coverageStore: CoverageStore,
    private readonly _selection: SelectionState,
    private readonly _resultsView: ResultsView,
    private readonly _observers: IResultObserver[],
    private readonly _outputChannel: vscode.OutputChannel,
    private readonly _statusBar: vscode.StatusBarItem,
    private readonly _discovery: TestDiscoveryService,
    private readonly _sessionDir: string,
  ) {
    this._traceRunner = new SessionTraceRunner(this._sessionDir, this._coverageStore);
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info(FILE, 'start', 'Session start requested');
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      logger.warn(FILE, 'start', 'No project root configured — prompting user');
      const pick = await vscode.window.showErrorMessage(
        'No project root found. Open a single folder or configure liveTestRunner.projectRoot.',
        'Select Project Root',
      );
      if (pick) {
        await this.selectProjectRoot();
      }
      return;
    }

    logger.info(FILE, 'start', `Project root: ${projectRoot}`);

    if (this._session) {
      logger.debug(FILE, 'start', 'Stopping existing session before starting a new one');
      this._session.stop();
      this._session = undefined;
    }

    // Reset all results to pending before starting a fresh run so the UI
    // immediately shows pending icons rather than stale pass/fail state.
    this._store.resetToPending();

    vscode.commands.executeCommand('liveTestRunner.results.focus');
    this._outputChannel.appendLine('');
    this._outputChannel.appendLine(
      `[Live Test Runner] Starting — ${projectRoot}`,
    );

    // Bootstrap a session with a Jest runner to hold the coverage map
    const cfg = vscode.workspace.getConfiguration('liveTestRunner');
    const cmd =
      cfg.get<string>('runMode') === 'npm'
        ? 'npm test --'
        : cfg.get<string>('jestCommand') || '';
    const bootstrapRunner = new JestRunner(
      cmd,
      (msg) => this._outputChannel.appendLine(msg),
      this._sessionDir,
    );
    this._session = new TestSession(bootstrapRunner);

    try {
      // ── Ensure discovery has run ───────────────────────────────────────────
      // If the store is empty (e.g. after a cache clear) and discovery is not
      // in progress, restart it so the user gets a fresh file list.
      if (!this._discovery.isDiscovering && this._store.getAllFiles().length === 0 && this._discovery.hasCompleted) {
        this._discovery.restart();
      }

      if (this._discovery.isDiscovering) {
        this._updateStatusBar('Waiting for discovery…');
        await this._discovery.awaitDiscovery();
      }

      // ── Derive the file list from the already-populated store ──────────────
      const testFiles = this._store.getAllFiles().map((f) => f.filePath);
      this._outputChannel.appendLine(
        `[Live Test Runner] Starting run — ${testFiles.length} file(s)`,
      );

      if (testFiles.length === 0) {
        this._updateStatusBar('✅ Ready');
        this._session.activate();
        return;
      }

      this._session.activate();
      this._traceRunner.reset();
      this._notify('onSessionStarted');

      // Background source scan — runs in parallel with test execution.
      this._coverageStore.clear();
      const sourceCounter = new SourceCounter(projectRoot, this._coverageStore);
      sourceCounter.on('progress', (scanned: number, total: number) => {
        this._observers.forEach((o) => o.onSourceScanProgress?.(scanned, total));
      });
      sourceCounter.on('done', () => {
        this._observers.forEach((o) => o.onSourceScanDone?.());
      });
      void sourceCounter.run();

      // Push the discovered (pending) tree to the UI so the run-started state
      // shows all tests before the first result arrives.
      this._notify('onRunStarted', {
        fileCount: testFiles.length,
        files: (this._store.toJSON() as { files: unknown[] }).files,
      });

      // ── Run the tests ──────────────────────────────────────────────────────
      await this._runFiles(testFiles, projectRoot, true);
      this._outputChannel.appendLine(
        `[Live Test Runner] Temporary trace files: ${this._sessionDir}`,
      );
    } catch (error) {
      logger.error(FILE, 'start', 'Unhandled error starting test session', error);
      this._updateStatusBar('❌ Error');
      vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
    }
  }

  stop(decorationManager: DecorationManager): void {
    logger.info(FILE, 'stop', 'Session stop requested');
    this._traceRunner.kill();
    if (this._session) {
      this._session.stop();
      this._session = undefined;
    }
    this._store.clearAllLineMaps();
    this._coverageStore.clear();
    this._notify('onSessionStopped');
    void decorationManager; // already in observers, notified above
    this._updateStatusBar('Off');
  }

  isActive(): boolean {
    return !!this._session?.isTestingActive();
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async selectProjectRoot(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('No workspace folders are open.');
      return;
    }
    const selected =
      folders.length === 1
        ? folders[0].uri.fsPath
        : await vscode.window.showQuickPick(
            folders.map((f: vscode.WorkspaceFolder) => f.uri.fsPath),
            { placeHolder: 'Select project root' },
          );
    if (selected) {
      await vscode.workspace
        .getConfiguration('liveTestRunner')
        .update('projectRoot', selected, vscode.ConfigurationTarget.Workspace);
    }
  }

  async rerunScope(args: {
    scope: string;
    fileId: string;
    nodeId?: string;
    fullName?: string;
  }): Promise<void> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      return;
    }

    // If running a dynamic test variation, we must pivot to the parent template anchor
    // because individual variations cannot be isolated by Jest name-filtering patterns.
    if (args.nodeId) {
      const node = this._store.getNode(args.nodeId);
      if (node) {
        let p: typeof node | undefined = node;
        while (p) {
          if (p.isDynamicTemplate) {
            args.nodeId = p.id;
            args.fullName = p.fullName;
            args.scope = 'suite';
            break;
          }
          p = p.parentId ? this._store.getNode(p.parentId) : undefined;
        }
      }
    }

    if ((args.scope === 'test' || args.scope === 'suite') && args.fullName) {
      if (args.nodeId) {
        this._store.markNodeRunning(args.nodeId);
      }
      this._notify(
        'onFilesRerunning',
        [args.fileId],
        args.nodeId,
      );
      this._updateStatusBar('Running… 1/1');
      try {
        logger.debug(FILE, 'rerunScope', `Running scoped test — scope=${args.scope} fileId="${args.fileId}" fullName="${args.fullName}"`);
        await this._adapter.runTestCase(
          this._store,
          args.fileId,
          nameToPattern(args.fullName),
          projectRoot,
          (msg) => this._outputChannel.appendLine(msg),
          { nodeId: args.nodeId },
        );
      } catch (error) {
        logger.error(FILE, 'rerunScope', `runTestCase failed — fileId="${args.fileId}" fullName="${args.fullName}"`, error);
        this._outputChannel.appendLine(
          `[Live Test Runner] Error: ${(error as Error).message}`,
        );
      }
      this._notify('onFileResult', args.fileId);
      this._refreshScopedLogs(args.fileId);
      this._updateStatusBar('✅ Ready');
      return;
    }

    await this._runFiles([args.fileId], projectRoot);
  }

  // ── Editor commands ───────────────────────────────────────────────────────

  async debugFromEditor(
    filePath: string,
    testFullName?: string,
  ): Promise<void> {
    logger.info(FILE, 'debugFromEditor', `Debug session requested — file="${filePath}" testFullName="${testFullName ?? '(all)'}"`);
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      logger.warn(FILE, 'debugFromEditor', 'No project root — aborting debug');
      return;
    }
    try {
      const folder = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.file(filePath),
      );
      const config = this._adapter.getDebugConfig(
        projectRoot,
        filePath,
        testFullName,
      );
      await vscode.debug.startDebugging(folder, config);
    } catch (err) {
      logger.error(FILE, 'debugFromEditor', `Failed to start debug session for "${filePath}"`, err);
    }
  }

  // ── On-save handler ────────────────────────────────────────────────────────

  onSave(document: vscode.TextDocument): void {
    if (!this._session?.isTestingActive()) {
      return;
    }
    const debounceMs =
      vscode.workspace
        .getConfiguration('liveTestRunner')
        .get<number>('onSaveDebounceMs') ?? 300;

    const filePath = document.uri.fsPath;
    const existing = this._saveTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(async () => {
      this._saveTimers.delete(filePath);
      if (!this._session) {
        return;
      }
      try {
        const projectRoot = this._getProjectRoot();
        if (!projectRoot) {
          return;
        }

        if (this._adapter.isTestFile(filePath)) {
          await this._runFiles([filePath], projectRoot);
        } else {
          this._coverageStore.markFileStale(filePath);
          await this._runAffectedBySourceFile(filePath, projectRoot);
        }
      } catch (error) {
        logger.error(FILE, 'onSave', `Error during on-save rerun for "${filePath}"`, error);
        this._updateStatusBar('✅ Ready');
        this._outputChannel.appendLine(
          `[Live Test Runner] Error: ${(error as Error).message}`,
        );
      }
    }, debounceMs);
    this._saveTimers.set(filePath, timer);
  }

  // ── Workspace change handler ───────────────────────────────────────────────

  onWorkspaceFoldersChanged(): void {
    if (this._session) {
      this._session.stop();
      this._session = undefined;
      this._store.clear();
      this._updateStatusBar('Off');
      this._notify('onRunFinished', {
        total: 0,
        passed: 0,
        failed: 0,
        totalDuration: 0,
        sessionActive: false,
      });
    }
  }

  // ── Private: source-file affected rerun ───────────────────────────────────

  /**
   * When a source (non-test) file is saved, determine which tests are affected
   * and rerun them as precisely as possible.
   *
   * Strategy (in priority order):
   *  1. Trace store has data → run each affected test file, but only the
   *     individual test cases that actually touched this source file. Suites
   *     with isSharedVars:true are run as a whole-suite pattern instead.
   *  2. No trace data yet → fall back to the adapter's CoverageMap /
   *     jest --findRelatedTests (existing behaviour).
   */
  private async _runAffectedBySourceFile(
    sourceFilePath: string,
    projectRoot: string,
  ): Promise<void> {
    const affectedTestFiles =
      this._traceStore.getAffectedTestFiles(sourceFilePath);

    if (affectedTestFiles.length === 0) {
      // No trace data — use jest --findRelatedTests as fallback. This runs Jest's
      // own static import-graph analysis: it finds test files that (transitively)
      // import the changed source file and reruns them whole. Less precise than
      // trace (whole file, not individual test cases) but correct as a safety net.
      logger.debug(FILE, '_runAffectedBySourceFile', `No trace data for "${sourceFilePath}" — falling back to --findRelatedTests`);
      const affectedPaths = await this._adapter.runRelatedTests(
        this._store,
        sourceFilePath,
        projectRoot,
        (msg) => this._outputChannel.appendLine(msg),
      );
      for (const fp of affectedPaths) {
        this._notify('onFileResult', fp);
        this._refreshScopedLogs(fp);
      }
      if (affectedPaths.length > 0) {
        const summary = this._store.getSummary();
        this._notify('onRunFinished', {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          totalDuration: undefined,
          sessionActive: this.isActive(),
        });
        this._updateStatusBar(
          summary.failed > 0
            ? `❌ ${summary.failed} failed, ${summary.passed} passed`
            : `✅ ${summary.passed} passed`,
        );
      }
      return;
    }

    // We have trace data: collect per-test-file run tasks
    const filesToRunFull: string[] = []; // run the whole file
    const testCasesToRun: { filePath: string; fullName: string }[] = [];

    for (const testFilePath of affectedTestFiles) {
      const suiteInfo = this._traceStore.getSuiteInfo(
        sourceFilePath,
        testFilePath,
      );

      if (Object.keys(suiteInfo).length === 0) {
        filesToRunFull.push(testFilePath);
        continue;
      }

      for (const [suiteName, suite] of Object.entries(suiteInfo)) {
        if (suite.isSharedVars) {
          // Shared state — must run the whole file to get correct results
          if (!filesToRunFull.includes(testFilePath)) {
            filesToRunFull.push(testFilePath);
          }
        } else if (suite.testCases.length === 0) {
          // If the suite was explicitly traced but had 0 individual tests execute
          // (e.g. an empty test.each([]) or for loop array), we MUST still run the suite 
          // recursively by its name since modifying the dependency might have populated it.
          testCasesToRun.push({ filePath: testFilePath, fullName: suiteName });
        } else {
          for (const testCase of suite.testCases) {
            testCasesToRun.push({ filePath: testFilePath, fullName: testCase });
          }
        }
      }
    }

    // Run whole files first (if any)
    if (filesToRunFull.length > 0) {
      await this._runFiles(filesToRunFull, projectRoot);
    }

    // Run individual test cases in parallel — one Jest invocation per file with
    // a combined --testNamePattern, up to CONCURRENCY files at a time.
    const individualCases = testCasesToRun.filter(
      (t) => !filesToRunFull.includes(t.filePath),
    );
    if (individualCases.length > 0) {
      await this._runTestCases(individualCases, projectRoot);
    }

    // Scoped reruns don't produce coverage data, so clear the stale flag now
    // that the rerun is complete — the existing counters are still valid.
    this._coverageStore.clearStale(sourceFilePath);
  }

  // ── Private: run test cases (parallel, one Jest invocation per file) ────────

  /**
   * Runs a set of individual test cases as efficiently as possible:
   *  - Groups cases by test file so each file gets one Jest invocation with a
   *    combined --testNamePattern (avoids spawning N processes for N tests).
   *  - Runs up to CONCURRENCY files in parallel, mirroring _runFiles.
   *  - Fires onFileResult as each file completes so the UI updates progressively.
   *
   * Called by _runAffectedBySourceFile for the individual-test path.
   */
  private async _runTestCases(
    cases: { filePath: string; fullName: string }[],
    projectRoot: string,
  ): Promise<void> {
    const CONCURRENCY = Math.max(1, Math.floor(os.cpus().length / 4));

    // Group by file — one Jest invocation per file with combined pattern
    const byFile = new Map<string, string[]>();
    for (const { filePath, fullName } of cases) {
      const arr = byFile.get(filePath) ?? [];
      arr.push(fullName);
      byFile.set(filePath, arr);
    }

    // Determine the run scope for each file by comparing the requested names
    // against what the store knows about the file's node tree.
    //
    // Promotion rules (applied per file):
    //  - All tests in the file covered → promote to full file run
    //  - Single test → run with nodeId opt
    //  - Everything else → run with pattern only (no opts)
    type ScopedRun =
      | { kind: 'node'; filePath: string; names: string[]; nodeId: string }
      | { kind: 'pattern'; filePath: string; names: string[] };

    const filesToRunFull: string[] = [];
    const scopedRuns: ScopedRun[] = [];

    for (const [filePath, names] of byFile) {
      const file = this._store.getFile(filePath);

      if (!file) {
        scopedRuns.push({ kind: 'pattern', filePath, names });
        continue;
      }

      const nameSet = new Set(names);

      // Check if every test in the file is covered → full file run
      const allFileTests = this._store.getFileNodes(filePath).filter(n => n.type === 'test');
      const allTestFullNames = allFileTests.map(n => n.fullName);
      if (allTestFullNames.length > 0 && allTestFullNames.every((n) => nameSet.has(n))) {
        filesToRunFull.push(filePath);
        continue;
      }

      // Try to find a single matching test node for targeted run
      if (names.length === 1) {
        const testNode = allFileTests.find(n => n.fullName === names[0]);
        if (testNode) {
          scopedRuns.push({ kind: 'node', filePath, names, nodeId: testNode.id });
          continue;
        }
      }

      // Fallback: pattern-only run
      scopedRuns.push({ kind: 'pattern', filePath, names });
    }

    // Promote full-file runs to _runFiles
    if (filesToRunFull.length > 0) {
      await this._runFiles(filesToRunFull, projectRoot);
    }

    if (scopedRuns.length === 0) {
      return;
    }

    // Mark affected nodes (and their descendants) as running
    for (const run of scopedRuns) {
      const allNodes = this._store.getFileNodes(run.filePath);
      const namesToMark = new Set(run.names);
      for (const node of allNodes) {
        if (namesToMark.has(node.fullName)) {
          this._store.markTestsRunning(run.filePath, node.id);
        }
      }
      this._notify('onFileResult', run.filePath);
    }

    const queue = [...scopedRuns];
    let completed = 0;
    this._updateStatusBar(`Running… 0/${queue.length}`);
    const log = (msg: string) => this._outputChannel.appendLine(msg);

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, queue.length) },
        async () => {
          while (true) {
            const run = queue.shift();
            if (!run) {
              break;
            }

            const names = run.names;
            const pattern = names.map(nameToPattern).join('|');

            const opts =
              run.kind === 'node' ? { nodeId: run.nodeId } :
              /* pattern */ { fullNames: new Set(run.names) };

            try {
              await this._adapter.runTestCase(
                this._store,
                run.filePath,
                pattern,
                projectRoot,
                log,
                opts,
              );
            } catch (err) {
              logger.error(FILE, '_runTestCases', `runTestCase failed — file="${run.filePath}" pattern="${pattern}"`, err);
              this._outputChannel.appendLine(
                `[Live Test Runner] Error: ${(err as Error).message}`,
              );
            }

            completed++;
            this._updateStatusBar(`Running… ${completed}/${queue.length + completed}`);
            this._notify('onFileResult', run.filePath);
            this._refreshScopedLogs(run.filePath);
          }
        },
      ),
    );

    const summary = this._store.getSummary();
    this._notify('onRunFinished', {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      totalDuration: undefined,
      sessionActive: this.isActive(),
    });
    this._updateStatusBar(
      summary.failed > 0
        ? `❌ ${summary.failed} failed, ${summary.passed} passed`
        : `✅ ${summary.passed} passed`,
    );
  }

  // ── Private: run execution ─────────────────────────────────────────────────

  private async _runFiles(
    filePaths: string[],
    projectRoot: string,
    isFullSuite = false,
  ): Promise<void> {
    const CONCURRENCY = Math.max(1, Math.floor(os.cpus().length / 4));
    const totalFiles  = filePaths.length;

    // Batch heuristic: amortise Jest startup across multiple files while keeping
    // batches small enough that the UI stays responsive (results stream per file).
    const BATCH_SIZE = Math.max(5, Math.min(50, Math.ceil(totalFiles / CONCURRENCY)));

    for (const fp of filePaths) {
      this._store.fileStarted(fp, fp, vscode.workspace.asRelativePath(fp));
    }

    if (!isFullSuite) {
      this._notify('onFilesRerunning', filePaths);
    }
    this._updateStatusBar(`Running… 0/${totalFiles}`);

    const totalStart = Date.now();
    const log = (msg: string) => this._outputChannel.appendLine(msg);

    let completed = 0;
    let numPassed  = 0;
    let numFailed  = 0;

    const onFileDone = (filePath: string, status: 'passed' | 'failed') => {
      if (status === 'passed') { numPassed++; } else { numFailed++; }
      completed++;
      this._updateStatusBar(`Running… ${completed}/${totalFiles}`);
      this._notify('onFileResult', filePath);
      this._refreshScopedLogs(filePath);
    };

    /** Split-on-crash: retry files that produced no result by halving the batch. */
    const runBatch = async (batch: string[]): Promise<void> => {
      if (batch.length === 0) { return; }
      // Mark all files in this batch as running immediately so the UI flips
      // from pending → running. One bulk notification per batch (not per file)
      // keeps the postMessage rate sane for large affected-file sets.
      for (const fp of batch) {
        this._store.markFileRunning(fp);
      }
      this._notify('onFilesRerunning', batch);
      let missing: string[];
      try {
        const r = await this._traceRunner.runFiles({
          filePaths: batch,
          projectRoot,
          traceStore: this._traceStore,
          store: this._store,
          applyFileResult: (fp, fr) => this._adapter.applyFileResult(this._store, fp, fr),
          onFileDone,
          log,
        });
        missing = r.missing;
      } catch (err) {
        logger.error(FILE, '_runFiles', `runFiles threw for batch of ${batch.length}`, err);
        missing = batch.slice();
      }

      if (missing.length === 0) { return; }

      // When the whole batch produced no results the most likely cause is a
      // jest config incompatibility rather than individual test crashes.
      // Fall back to the adapter's per-file runner (the v1.3.0 path) with
      // the same CONCURRENCY limit used by the main queue — do NOT run all
      // files in parallel, which would flood the machine with jest processes.
      if (missing.length === batch.length) {
        logger.warn(FILE, '_runFiles', `SessionTraceRunner produced no results for entire batch of ${batch.length} — falling back to per-file adapter run`);
        const fallbackQueue = [...missing];
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, fallbackQueue.length) }, async () => {
            while (true) {
              const fp = fallbackQueue.shift();
              if (!fp) { break; }
              try {
                const status = await this._adapter.runFile(this._store, fp, projectRoot, log);
                onFileDone(fp, status);
              } catch (err) {
                logger.error(FILE, '_runFiles', `Adapter fallback also failed for "${fp}"`, err);
                this._store.fileResult(fp, 'failed');
                onFileDone(fp, 'failed');
              }
            }
          }),
        );
        return;
      }

      // Partial miss: some files produced results so remaining ones likely
      // crashed mid-batch. Split and retry with smaller batches.
      if (missing.length === 1) {
        const fp = missing[0];
        logger.warn(FILE, '_runFiles', `No result for "${fp}" — falling back to per-file adapter run`);
        try {
          const status = await this._adapter.runFile(this._store, fp, projectRoot, log);
          onFileDone(fp, status);
        } catch (err) {
          logger.error(FILE, '_runFiles', `Adapter fallback also failed for "${fp}"`, err);
          this._store.fileResult(fp, 'failed');
          onFileDone(fp, 'failed');
        }
        return;
      }
      const half = Math.ceil(missing.length / 2);
      await runBatch(missing.slice(0, half));
      await runBatch(missing.slice(half));
    };

    // Build batch queue up-front and drain it with CONCURRENCY workers.
    const batchQueue: string[][] = [];
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      batchQueue.push(filePaths.slice(i, i + BATCH_SIZE));
    }

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, batchQueue.length) },
        async () => {
          while (true) {
            const batch = batchQueue.shift();
            if (!batch) { break; }
            await runBatch(batch);
          }
        },
      ),
    );

    this._outputChannel.appendLine(
      `[Live Test Runner] Finished in ${Date.now() - totalStart}ms`,
    );

    const summary = this._store.getSummary();
    this._notify('onRunFinished', {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      totalDuration: isFullSuite ? Date.now() - totalStart : undefined,
      sessionActive: this.isActive(),
    });

    if (numFailed > 0) {
      this._updateStatusBar(`❌ ${numFailed} failed, ${numPassed} passed`);
    } else if (numPassed > 0) {
      this._updateStatusBar(`✅ ${numPassed} passed`);
    }

    this._discovery.pruneGhostFiles();
  }

  // ── Private: helpers ───────────────────────────────────────────────────────

  private _notify<K extends keyof IResultObserver>(
    method: K,
    ...args: Parameters<
      IResultObserver[K] extends (...a: never[]) => unknown
        ? IResultObserver[K]
        : never
    >
  ): void {
    for (const obs of this._observers) {
      (obs[method] as (...a: unknown[]) => void)(...(args as unknown[]));
    }
  }

  private _refreshScopedLogs(fileId: string): void {
    const sel = this._selection.get();
    if (sel?.fileId === fileId) {
      this._resultsView.sendScopedData(sel.fileId, sel.nodeId);
    }
  }

  private _getProjectRoot(): string | undefined {
    const configured = vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<string>('projectRoot');
    if (configured?.trim()) {
      return configured.trim();
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }

  private _updateStatusBar(text: string): void {
    this._statusBar.text = `Live Tests: ${text}`;
  }
}
