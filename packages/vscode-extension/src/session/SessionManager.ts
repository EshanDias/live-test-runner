import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { JestRunner, FrameworkDetector } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver } from '../IResultObserver';
import { IFrameworkAdapter } from '../framework/IFrameworkAdapter';
import { DecorationManager } from '../editor/DecorationManager';
import { ResultsView } from '../views/ResultsView';
import { TestDiscoveryService } from './TestDiscoveryService';
import { SessionTraceRunner } from './SessionTraceRunner';
import { ProjectJestConfig } from './ProjectJestConfig';
import { CoverageStore } from '../coverage/CoverageStore';
import { SourceCounter } from '../coverage/SourceCounter';
import { logger } from '../utils/logger';

const log = logger.scope('Session');

/** "a.test.ts, b.test.ts, +3 more" — keeps summary lines to one readable line. */
function shortList(paths: string[], max = 5): string {
  const names = paths.map((p) => path.basename(p));
  return names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')}, +${names.length - max} more`;
}

function secondsSince(t: number): string {
  return `${((Date.now() - t) / 1000).toFixed(1)}s`;
}

/** Failure shown on the tests of a file that was stopped for running too long. */
function hangMessage(seconds: number): string {
  return `Stopped after ${seconds}s without finishing — a test in this file probably hangs ` +
    '(an infinite loop or a promise that never resolves). ' +
    'Raise liveTestRunner.hangTimeoutSeconds if the file is just slow.';
}

/** Key for comparing test-file paths with `jest --listTests` output. */
function runnableKey(filePath: string): string {
  const p = path.normalize(filePath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

interface RunHandle {
  id: number;
  label: string;
  startedAt: number;
  /** The session token at start — a run from before Stop never closes the current state. */
  token: number;
}

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
  /** Monotonic run counter — every log line about a run carries "Run #N". */
  private _runSeq = 0;

  /**
   * Changes on every Start and Stop. Work started under an older token stops
   * before its next step (next batch, retry, fallback) — Stop is final.
   */
  private _token = 0;
  /**
   * Runs in progress (full suite, saves, ▶ Run …). They can overlap, so
   * "finished" is only announced when the last one ends (BUG-15).
   */
  private _activeRuns = 0;
  /** Files scheduled / finished across all active runs — drives the progress UI. */
  private _progress = { completed: 0, total: 0, failed: 0 };
  /** Set while a full-suite run is part of the active runs. */
  private _fullSuiteStartedAt: number | undefined;
  /**
   * Files the project's Jest config would run (`jest --listTests`), lower-cased
   * on Windows. undefined = unknown (listing failed): run everything.
   */
  private _runnable: Set<string> | undefined;

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
    private readonly _projectConfig: ProjectJestConfig,
  ) {
    this._traceRunner = new SessionTraceRunner(this._sessionDir, this._coverageStore, this._projectConfig);
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      log.warn('Start Testing: no project root — open a single folder or set liveTestRunner.projectRoot');
      const pick = await vscode.window.showErrorMessage(
        'No project root found. Open a single folder or configure liveTestRunner.projectRoot.',
        'Select Project Root',
      );
      if (pick) {
        await this.selectProjectRoot();
      }
      return;
    }

    if (this._session) {
      log.debug('Restarting: stopping the existing session first');
      this._traceRunner.kill();
      this._session.stop();
      this._session = undefined;
    }
    const token = ++this._token;
    this._activeRuns = 0;
    this._fullSuiteStartedAt = undefined;
    this._clearSaveTimers();

    // Reset all results to pending before starting a fresh run so the UI
    // immediately shows pending icons rather than stale pass/fail state.
    this._store.resetToPending();

    vscode.commands.executeCommand('liveTestRunner.results.focus');

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
        log.debug('Start Testing: waiting for discovery to finish');
        await this._discovery.awaitDiscovery();
      }

      // ── Derive the file list from the already-populated store ──────────────
      const discovered = this._store.getAllFiles().map((f) => f.filePath);
      let framework = 'unknown';
      try { framework = new FrameworkDetector().detectFramework(projectRoot); } catch { /* logged by detector */ }

      // Ask Jest which of the discovered files the project's config runs, and
      // (in parallel) how it resolves that config — re-read every session.
      this._projectConfig.reset();
      void this._projectConfig.get(projectRoot);
      this._runnable = await this._listRunnableFiles(projectRoot);
      if (token !== this._token) { return; }
      const testFiles = discovered.filter((fp) => this._isRunnable(fp));
      this._markExcluded(discovered.filter((fp) => !this._isRunnable(fp)));
      log.info(`Session started — ${testFiles.length} test file(s) · framework: ${framework} · root: ${projectRoot}`);

      if (testFiles.length === 0) {
        log.warn('No test files found — nothing to run. Test files must match *.test.* or *.spec.* (js, ts, jsx, tsx, mjs, cjs)');
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
      const run = this._beginRun('full suite', { fullSuite: true });
      try {
        await this._runFiles(testFiles, projectRoot, token);
      } finally {
        this._endRun(run, testFiles);
      }
    } catch (error) {
      log.error('Start Testing failed', error);
      this._updateStatusBar('❌ Error');
      vscode.window.showErrorMessage(`Failed to start testing: ${error}`);
    }
  }

  stop(decorationManager: DecorationManager): void {
    if (this._session) { log.info('Session stopped'); }
    this._token++;
    this._clearSaveTimers();
    this._traceRunner.kill();
    if (this._session) {
      this._session.stop();
      this._session = undefined;
    }
    // Nothing may keep spinning after Stop (BUG-23).
    const touched = this._store.resetRunning();
    this._activeRuns = 0;
    this._fullSuiteStartedAt = undefined;
    this._store.clearAllLineMaps();
    this._coverageStore.clear();
    for (const fp of touched) { this._notify('onFileResult', fp); }
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

    if (!this._isRunnable(args.fileId)) {
      log.info(`${path.basename(args.fileId)} is not run by this project's Jest config (testMatch / testPathIgnorePatterns) — nothing to run`);
      return;
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
      const run = this._beginRun(`${args.scope} "${args.fullName}"`);
      this._addPlanned(1);
      let ok = false;
      try {
        ok = await this._adapter.runTestCase(
          this._store,
          args.fileId,
          nameToPattern(args.fullName),
          projectRoot,
          (msg) => this._outputChannel.appendLine(msg),
          { nodeId: args.nodeId },
        );
      } catch (error) {
        log.error(`Run #${run.id} failed to run ${args.scope} "${args.fullName}" in ${path.basename(args.fileId)}`, error);
      } finally {
        if (!ok) { this._store.cleanupStaleNodes(args.fileId, false, args.nodeId); }
        this._fileFinished(this._store.getFile(args.fileId)?.status === 'failed' ? 'failed' : 'passed');
        this._notify('onFileResult', args.fileId);
        this._refreshScopedLogs(args.fileId);
        this._endRun(run, [args.fileId], args.nodeId);
      }
      return;
    }

    const run = this._beginRun(`file ${path.basename(args.fileId)}`);
    try {
      await this._runFiles([args.fileId], projectRoot, this._token);
    } finally {
      this._endRun(run, [args.fileId]);
    }
  }

  // ── Editor commands ───────────────────────────────────────────────────────

  /** @returns the launch configuration used, or undefined when nothing was started. */
  async debugFromEditor(
    filePath: string,
    testFullName?: string,
    isSuite = false,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const projectRoot = this._getProjectRoot();
    if (!projectRoot) {
      log.warn('Debug: no project root configured — nothing to debug');
      return undefined;
    }
    log.info(`Debug: ${testFullName ? `${isSuite ? 'suite' : 'test'} "${testFullName}"` : 'whole file'} in ${path.basename(filePath)}`);
    try {
      const folder = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.file(filePath),
      );
      const config = await this._adapter.getDebugConfig(
        projectRoot,
        filePath,
        testFullName,
        isSuite,
      );
      const started = await vscode.debug.startDebugging(folder, config);
      if (!started) {
        log.warn(`Debug: VS Code refused to start the debug session (program: ${config.program})`);
        return undefined;
      }
      return config;
    } catch (err) {
      log.error(`Debug: could not start a debug session for ${filePath}`, err);
      return undefined;
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
    // Only the project's own JS/TS files matter — VS Code also saves its
    // settings.json, untitled buffers, files in other folders, etc.
    const root = this._getProjectRoot();
    const rel = root ? path.relative(root, filePath) : '';
    if (
      !root || document.uri.scheme !== 'file' ||
      rel.startsWith('..') || path.isAbsolute(rel) ||
      /(^|[\\/])node_modules[\\/]/.test(rel) ||
      !/\.(c|m)?[jt]sx?$/i.test(filePath)
    ) {
      return;
    }
    const existing = this._saveTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const token = this._token;
    const timer = setTimeout(async () => {
      this._saveTimers.delete(filePath);
      if (!this._session || token !== this._token) {
        return;
      }
      const projectRoot = this._getProjectRoot();
      if (!projectRoot) {
        return;
      }

      const isTestFile = this._adapter.isTestFile(filePath);
      if (isTestFile && !this._isRunnable(filePath)) {
        log.debug(`Saved ${path.basename(filePath)} — not run by this project's Jest config, ignoring`);
        return;
      }
      const run = this._beginRun(`save ${path.basename(filePath)}`);
      let ran: string[] = [];
      try {
        if (isTestFile) {
          ran = [filePath];
          await this._runFiles(ran, projectRoot, token);
        } else {
          this._coverageStore.markFileStale(filePath);
          ran = await this._runAffectedBySourceFile(filePath, projectRoot, token);
        }
      } catch (error) {
        log.error(`On-save rerun failed for ${filePath}`, error);
      } finally {
        if (ran.length === 0) {
          log.info(`Run #${run.id} save ${path.basename(filePath)} — no tests depend on this file`);
        }
        this._endRun(run, ran, undefined, ran.length === 0);
      }
    }, debounceMs);
    this._saveTimers.set(filePath, timer);
  }

  // ── Workspace change handler ───────────────────────────────────────────────

  onWorkspaceFoldersChanged(): void {
    if (this._session) {
      this._token++;
      this._activeRuns = 0;
      this._clearSaveTimers();
      this._traceRunner.kill();
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
  /** @returns the test files that were rerun (empty when nothing depends on the file). */
  private async _runAffectedBySourceFile(
    sourceFilePath: string,
    projectRoot: string,
    token: number,
  ): Promise<string[]> {
    const affectedTestFiles = this._traceStore
      .getAffectedTestFiles(sourceFilePath)
      .filter((fp) => this._isRunnable(fp));

    if (affectedTestFiles.length === 0) {
      // No trace data — use jest --findRelatedTests as fallback. This runs Jest's
      // own static import-graph analysis: it finds test files that (transitively)
      // import the changed source file and reruns them whole. Less precise than
      // trace (whole file, not individual test cases) but correct as a safety net.
      log.debug(`No trace data for ${path.basename(sourceFilePath)} — using jest --findRelatedTests`);
      this._addPlanned(1);
      const affectedPaths = await this._adapter.runRelatedTests(
        this._store,
        sourceFilePath,
        projectRoot,
        (msg) => this._outputChannel.appendLine(msg),
      );
      this._fileFinished('passed');
      if (token !== this._token) { return affectedPaths; }
      for (const fp of affectedPaths) {
        this._notify('onFileResult', fp);
        this._refreshScopedLogs(fp);
      }
      return affectedPaths;
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

    const individualCases = testCasesToRun.filter(
      (t) => !filesToRunFull.includes(t.filePath),
    );
    log.debug(
      `Trace-based rerun for ${path.basename(sourceFilePath)}: ` +
      `${filesToRunFull.length} whole file(s), ${individualCases.length} individual test(s)`,
    );

    // Run whole files first (if any)
    if (filesToRunFull.length > 0) {
      await this._runFiles(filesToRunFull, projectRoot, token);
    }

    // Run individual test cases in parallel — one Jest invocation per file with
    // a combined --testNamePattern, up to CONCURRENCY files at a time.
    if (individualCases.length > 0 && token === this._token) {
      await this._runTestCases(individualCases, projectRoot, token);
    }

    // Scoped reruns don't produce coverage data, so clear the stale flag now
    // that the rerun is complete — the existing counters are still valid.
    this._coverageStore.clearStale(sourceFilePath);

    return [...new Set([...filesToRunFull, ...individualCases.map((c) => c.filePath)])];
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
    token: number,
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
      await this._runFiles(filesToRunFull, projectRoot, token);
    }

    if (scopedRuns.length === 0 || token !== this._token) {
      return;
    }

    // Mark affected nodes (and their descendants) as running. These files
    // start right away (one Jest each), so ⟳ is accurate here.
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
    this._addPlanned(queue.length);
    const rawLog = (msg: string) => this._outputChannel.appendLine(msg);

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, queue.length) },
        async () => {
          while (token === this._token) {
            const run = queue.shift();
            if (!run) {
              break;
            }

            const names = run.names;
            const pattern = names.map(nameToPattern).join('|');

            const opts =
              run.kind === 'node' ? { nodeId: run.nodeId } :
              /* pattern */ { fullNames: new Set(run.names) };

            let ok = false;
            try {
              ok = await this._adapter.runTestCase(
                this._store,
                run.filePath,
                pattern,
                projectRoot,
                rawLog,
                opts,
              );
            } catch (err) {
              log.error(`Could not run ${names.length} test(s) in ${path.basename(run.filePath)} (pattern ${pattern})`, err);
            }
            if (token !== this._token) { break; }
            // No result: put the spinning tests back to pending (BUG-23).
            if (!ok) { this._store.cleanupStaleNodes(run.filePath, false, run.kind === 'node' ? run.nodeId : undefined); }

            this._fileFinished(this._store.getFile(run.filePath)?.status === 'failed' ? 'failed' : 'passed');
            this._notify('onFileResult', run.filePath);
            this._refreshScopedLogs(run.filePath);
          }
        },
      ),
    );
  }

  // ── Private: run execution ─────────────────────────────────────────────────

  private async _runFiles(
    filePaths: string[],
    projectRoot: string,
    token: number,
  ): Promise<void> {
    const CONCURRENCY = Math.max(1, Math.floor(os.cpus().length / 4));
    const totalFiles  = filePaths.length;
    if (totalFiles === 0 || token !== this._token) { return; }

    // Batch heuristic: amortise Jest startup across multiple files while keeping
    // batches small enough that the UI stays responsive (results stream per file).
    const BATCH_SIZE = Math.max(5, Math.min(50, Math.ceil(totalFiles / CONCURRENCY)));

    // Files are NOT marked running here: in a batch Jest runs its files one
    // after another, so a queued file only shows ⟳ once Jest starts it (BUG-23).
    for (const fp of filePaths) {
      if (!this._store.getFile(fp)) {
        this._store.fileDiscovered(fp, fp, vscode.workspace.asRelativePath(fp));
      }
    }
    this._addPlanned(totalFiles);

    const totalStart = Date.now();
    const rawLog = (msg: string) => this._outputChannel.appendLine(msg);
    const live = () => token === this._token;
    const hangTimeoutMs = 1000 * (vscode.workspace
      .getConfiguration('liveTestRunner')
      .get<number>('hangTimeoutSeconds') ?? 300);

    const onFileDone = (filePath: string, status: 'passed' | 'failed') => {
      this._fileFinished(status);
      this._notify('onFileResult', filePath);
      this._refreshScopedLogs(filePath);
    };

    const markRunning = (filePath: string) => {
      if (this._store.getFile(filePath)?.status === 'running') { return; }
      this._store.markFileRunning(filePath);
      this._notify('onFilesRerunning', [filePath]);
    };

    /** Plain-Jest run of one file, with the spinner cleared on every outcome. */
    const runPlain = async (fp: string): Promise<void> => {
      if (!live()) { return; }
      markRunning(fp);
      const startedAt = Date.now();
      let status: 'passed' | 'failed' = 'failed';
      try {
        status = await this._adapter.runFile(this._store, fp, projectRoot, rawLog);
      } catch (err) {
        log.error(`Plain Jest fallback also failed for ${fp}`, err);
      }
      if (!live()) { return; }
      if (this._store.getFile(fp)?.status === 'running') {
        // No result at all. Either the file hung and was stopped, or Jest
        // could not run it — never leave it spinning (BUG-23).
        if (hangTimeoutMs > 0 && Date.now() - startedAt >= hangTimeoutMs) {
          this._store.failFile(fp, hangMessage(Math.round((Date.now() - startedAt) / 1000)));
        } else {
          this._store.cleanupStaleNodes(fp, false);
          this._store.fileResult(fp, 'failed');
        }
      }
      onFileDone(fp, status);
    };

    /** Split-on-crash: retry files that produced no result by halving the batch. */
    const runBatch = async (batch: string[]): Promise<void> => {
      if (batch.length === 0 || !live()) { return; }
      // A single-file batch starts right away — show it running now.
      if (batch.length === 1) { markRunning(batch[0]); }
      let missing: string[];
      try {
        const r = await this._traceRunner.runFiles({
          filePaths: batch,
          projectRoot,
          traceStore: this._traceStore,
          store: this._store,
          applyFileResult: (fp, fr) => {
            // Results replace the file's tests; mark them running first so
            // stale discovery placeholders are cleaned up.
            if (this._store.getFile(fp)?.status !== 'running') { this._store.markFileRunning(fp); }
            this._adapter.applyFileResult(this._store, fp, fr);
          },
          onFileDone,
          onFileStart: markRunning,
          onFileTimedOut: (fp, seconds) => {
            this._store.failFile(fp, hangMessage(seconds));
            onFileDone(fp, 'failed');
          },
          hangTimeoutMs,
          log: rawLog,
        });
        missing = r.missing;
      } catch (err) {
        log.error(`Batch of ${batch.length} file(s) crashed — retrying without instrumentation`, err);
        missing = batch.slice();
      }

      // Stopped (or restarted) meanwhile: no retries, no fallback (BUG-15).
      if (missing.length === 0 || !live()) { return; }

      // When the whole batch produced no results the most likely cause is a
      // jest config incompatibility rather than individual test crashes.
      // Fall back to the adapter's per-file runner (the v1.3.0 path) with
      // the same CONCURRENCY limit used by the main queue — do NOT run all
      // files in parallel, which would flood the machine with jest processes.
      if (missing.length === batch.length) {
        log.warn(
          `No results from the instrumented run for ${batch.length} file(s) — falling back to plain Jest, one file at a time ` +
          `(slower; no coverage or smart reruns for these files). Files: ${shortList(batch)}`,
        );
        const fallbackQueue = [...missing];
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, fallbackQueue.length) }, async () => {
            while (live()) {
              const fp = fallbackQueue.shift();
              if (!fp) { break; }
              await runPlain(fp);
            }
          }),
        );
        return;
      }

      // Partial miss: some files produced results so remaining ones likely
      // crashed mid-batch. Split and retry with smaller batches.
      if (missing.length === 1) {
        log.warn(`No result for ${path.basename(missing[0])} — retrying it with plain Jest`);
        await runPlain(missing[0]);
        return;
      }
      log.debug(`${missing.length} file(s) in a batch produced no result — splitting the batch and retrying`);
      const half = Math.ceil(missing.length / 2);
      await runBatch(missing.slice(0, half));
      await runBatch(missing.slice(half));
    };

    // Build batch queue up-front and drain it with CONCURRENCY workers.
    const batchQueue: string[][] = [];
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      batchQueue.push(filePaths.slice(i, i + BATCH_SIZE));
    }
    const batchCount = batchQueue.length;

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, batchQueue.length) },
        async () => {
          while (live()) {
            const batch = batchQueue.shift();
            if (!batch) { break; }
            await runBatch(batch);
          }
        },
      ),
    );

    if (live()) {
      log.debug(`${totalFiles} file(s) finished in ${secondsSince(totalStart)} (${batchCount} batch(es), concurrency ${CONCURRENCY})`);
    }
  }

  // ── Private: run tracking ──────────────────────────────────────────────────

  /** Adds files to the progress of the runs in flight. */
  private _addPlanned(files: number): void {
    this._progress.total += files;
    this._postProgress();
  }

  private _fileFinished(status: 'passed' | 'failed'): void {
    this._progress.completed++;
    if (status === 'failed') { this._progress.failed++; }
    this._postProgress();
  }

  private _postProgress(): void {
    const { completed, total, failed } = this._progress;
    this._updateStatusBar(`Running… ${completed}/${total}`);
    for (const o of this._observers) { o.onRunProgress?.(completed, total, failed); }
  }

  /** Called when the last run in flight ends: one "finished" for everything. */
  private _finishRuns(): void {
    const summary = this._store.getSummary();
    const totalDuration = this._fullSuiteStartedAt !== undefined ? Date.now() - this._fullSuiteStartedAt : undefined;
    this._fullSuiteStartedAt = undefined;
    this._notify('onRunFinished', {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      totalDuration,
      sessionActive: this.isActive(),
    });
    this._updateStatusBar(
      summary.failed > 0
        ? `❌ ${summary.failed} failed, ${summary.passed} passed`
        : `✅ ${summary.passed} passed`,
    );
    this._discovery.pruneGhostFiles();
  }

  private _clearSaveTimers(): void {
    for (const t of this._saveTimers.values()) { clearTimeout(t); }
    this._saveTimers.clear();
  }

  // ── Private: which files Jest runs ─────────────────────────────────────────

  /**
   * `jest --listTests` with the project's own config: the files Jest would
   * run. Discovery globs every *.test.* / *.spec.* file, including ones the
   * config excludes (e2e specs, ignored folders, .mjs) — running those only
   * produced "No tests found" and spinners (BUG-24).
   */
  private async _listRunnableFiles(projectRoot: string): Promise<Set<string> | undefined> {
    const startedAt = Date.now();
    try {
      const files = await this._adapter.discoverTests(projectRoot, (msg) => this._outputChannel.appendLine(msg));
      if (files.length === 0) { return undefined; }
      log.debug(`jest --listTests: ${files.length} file(s) in ${secondsSince(startedAt)}`);
      return new Set(files.map(runnableKey));
    } catch (err) {
      log.warn('Could not ask Jest which files it runs (jest --listTests) — running every discovered test file', err);
      return undefined;
    }
  }

  private _isRunnable(filePath: string): boolean {
    return !this._runnable || this._runnable.has(runnableKey(filePath));
  }

  private _markExcluded(files: string[]): void {
    if (files.length === 0) { return; }
    for (const fp of files) {
      this._store.markFileExcluded(fp, "Not run: this project's Jest config excludes this file (testMatch / testRegex / testPathIgnorePatterns).");
    }
    log.info(`${files.length} test file(s) are not run by this project's Jest config and are shown as skipped: ${shortList(files)}`);
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

  /**
   * Opens a run: allocates "Run #N", writes a separator into the raw Jest
   * output and registers it as in flight. Every _beginRun needs an _endRun.
   */
  private _beginRun(label: string, opts: { fullSuite?: boolean } = {}): RunHandle {
    const id = ++this._runSeq;
    this._outputChannel.appendLine('');
    this._outputChannel.appendLine(`──── Run #${id} · ${label} · ${new Date().toLocaleTimeString()} ────`);
    log.debug(`Run #${id} started: ${label}`);
    if (this._activeRuns++ === 0) {
      this._progress = { completed: 0, total: 0, failed: 0 };
    }
    if (opts.fullSuite) { this._fullSuiteStartedAt = Date.now(); }
    return { id, label, startedAt: Date.now(), token: this._token };
  }

  /**
   * Closes a run with ONE summary line (unless `quiet`) and, when it was the
   * last run in flight, announces that everything finished. Counts only the
   * tests that belong to the run (the given files, or the subtree of `nodeId`).
   */
  private _endRun(
    run: RunHandle,
    fileIds: string[],
    nodeId?: string,
    quiet = false,
  ): void {
    if (run.token !== this._token) {
      // Stopped or restarted meanwhile — stop()/start() already reset the run state.
      log.debug(`Run #${run.id} ${run.label} — stopped after ${secondsSince(run.startedAt)}`);
      return;
    }
    if (!quiet) { this._logRunSummary(run, fileIds, nodeId); }
    this._activeRuns = Math.max(0, this._activeRuns - 1);
    if (this._activeRuns === 0) { this._finishRuns(); }
  }

  private _logRunSummary(run: RunHandle, fileIds: string[], nodeId?: string): void {
    const tests = nodeId
      ? (() => {
          const n = this._store.getNode(nodeId);
          return n?.type === 'test' ? [n] : this._store.getDescendantTests(nodeId);
        })()
      : this._store.getTestNodesForFiles(fileIds);

    let passed = 0, failed = 0, skipped = 0, notRun = 0;
    for (const t of tests) {
      if (t.status === 'passed') { passed++; }
      else if (t.status === 'failed') { failed++; }
      else if (t.status === 'skipped') { skipped++; }
      else { notRun++; }
    }

    const parts = [
      `${fileIds.length} file(s)`,
      `${passed} passed`,
      `${failed} failed`,
      ...(skipped ? [`${skipped} skipped`] : []),
      ...(notRun ? [`${notRun} not run`] : []),
      secondsSince(run.startedAt),
    ];
    const failingFiles = fileIds.filter((f) => this._store.getFile(f)?.status === 'failed');
    const failing = failingFiles.length ? ` — failing: ${shortList(failingFiles)}` : '';
    log.info(`Run #${run.id} ${run.label} — ${parts.join(' · ')}${failing}`);
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
