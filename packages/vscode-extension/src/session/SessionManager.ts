import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestSession } from '@live-test-runner/core';
import { FrameworkDetector, LTR_BASE_TMP_DIR, registerProjectRoot, fromRunnerPath } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { SelectionState } from '../store/SelectionState';
import { IResultObserver } from '../IResultObserver';
import { IFrameworkAdapter } from '../framework/IFrameworkAdapter';
import { FrameworkServices, FrameworkTerms, IFrameworkServicesProvider } from '../framework/FrameworkServices';
import { PLAIN_RUN_HANG_FACTOR } from '../constants';
import { DecorationManager } from '../editor/DecorationManager';
import { ResultsView } from '../views/ResultsView';
import { TestDiscoveryService } from './TestDiscoveryService';
import type { IBatchRunner } from './IBatchRunner';
import { RunnableFilesCache, runnableCacheKey, runnableKey } from './RunnableFiles';
import { CoverageStore } from '../coverage/CoverageStore';
import { SourceCounter } from '../coverage/SourceCounter';
import { coverageScopeOf } from '../coverage/coverageScope';
import { logger } from '../utils/logger';

const log = logger.scope('Session');

/** Comparable keys of Jest's runnable-file list; undefined = unknown (run everything). */
function toRunnableSet(files: string[] | undefined): Set<string> | undefined {
  return files ? new Set(files.map(runnableKey)) : undefined;
}

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

interface RunHandle {
  id: number;
  label: string;
  startedAt: number;
  /** The session token at start — a run from before Stop never closes the current state. */
  token: number;
}

import { nameToPattern } from '../utils/testNames';
export { nameToPattern };

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
  /** `jest --listTests` answers kept between sessions (see RunnableFiles). */
  private readonly _runnableCache = new RunnableFilesCache(LTR_BASE_TMP_DIR);

  /** The framework's file groups (Vitest project names) from the last runnable-files answer. */
  private _groups: Record<string, string> | undefined;
  /** Mixed projects: each listed file's framework (remembered with the list). */
  private _frameworks: Record<string, string> | undefined;

  constructor(
    /** The project this manager runs (one SessionManager per project, phase 7). */
    private readonly _projectRoot: string,
    /** The framework bundle (adapter, batch runner, config, …) for each file / project root. */
    private readonly _services: IFrameworkServicesProvider,
    private readonly _store: ResultStore,
    private readonly _traceStore: ExecutionTraceStore,
    private readonly _coverageStore: CoverageStore,
    private readonly _selection: SelectionState,
    /** Refreshes the Results view's scoped logs (a no-op while the project is in the background). */
    private readonly _resultsView: Pick<ResultsView, 'sendScopedData'>,
    private readonly _observers: IResultObserver[],
    private readonly _outputChannel: vscode.OutputChannel,
    /** Where the status text goes — the project's slot in the status bar (ProjectRegistry renders it). */
    private readonly _statusBar: { text: string },
    private readonly _discovery: TestDiscoveryService,
  ) {}

  /** The framework adapter that handles a file or project root. */
  private _adapterFor(fileOrRoot: string): IFrameworkAdapter {
    return this._services.servicesFor(fileOrRoot).adapter;
  }

  /** The framework's wording for log and status messages. */
  private _terms(fileOrRoot: string): FrameworkTerms {
    return this._services.servicesFor(fileOrRoot).terms;
  }

  /** Stop every framework's running batches (final until a new session). */
  private _killBatches(): void {
    for (const services of this._services.all()) { services.batchRunner.kill(); }
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    const projectRoot = this._getProjectRoot();

    if (this._session) {
      log.debug('Restarting: stopping the existing session first');
      this._killBatches();
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

    // Which framework(s) the project runs, re-read every Start (phase 8: a mixed project has two).
    this._services.prepare(projectRoot);
    // Bootstrap a session with the main framework's runner to hold the coverage map
    const services = this._services.servicesFor(projectRoot);
    this._session = new TestSession(services.createSessionRunner());

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
      services.projectConfig.reset();
      void services.projectConfig.get(projectRoot);
      const runnableList = await this._runnableFiles(projectRoot, discovered);
      if (token !== this._token) { return; }
      // A mixed project's second framework: its config is re-read too.
      for (const s of this._services.all()) {
        if (s !== services) { s.projectConfig.reset(); void s.projectConfig.get(projectRoot); }
      }
      if (this._services.isMixed()) { framework = `${framework} + ${services.framework === 'vitest' ? 'jest' : 'vitest'}`; }
      this._runnable = toRunnableSet(runnableList);
      if (runnableList) {
        // Files Jest runs that the glob patterns missed (custom testMatch / testRegex).
        const known = new Set(discovered.map(runnableKey));
        const added = this._discovery.addFiles(runnableList.filter((fp) => !known.has(runnableKey(fp))));
        if (added > 0) {
          log.info(`Added ${added} test file(s) that the project's ${this._terms(projectRoot).config} runs but discovery did not list (the testFilePatterns setting does not match them, or their tests are generated at runtime)`);
          discovered.splice(0, discovered.length, ...this._store.getAllFiles().map((f) => f.filePath));
        }
      }
      const testFiles = discovered.filter((fp) => this._isRunnable(fp));
      this._markExcluded(discovered.filter((fp) => !this._isRunnable(fp)));
      // D12: a config with several Vitest projects groups the Explorer by project name.
      this._store.setFileGroups(runnableList ? this._groups : undefined);
      log.info(`Session started — ${testFiles.length} test file(s) · framework: ${framework} · root: ${projectRoot}`);

      if (testFiles.length === 0) {
        log.warn(`No test files found — nothing to run. ${this._terms(projectRoot).name} listed no test files, and none match the liveTestRunner.testFilePatterns setting`);
        this._updateStatusBar('✅ Ready');
        this._session.activate();
        return;
      }

      this._session.activate();
      for (const s of this._services.all()) { s.batchRunner.reset(); }
      this._notify('onSessionStarted');

      // Background source scan — runs in parallel with test execution.
      this._coverageStore.clear();
      const sourceCounter = new SourceCounter(projectRoot, this._coverageStore, coverageScopeOf(services.projectConfig, projectRoot));
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
    this._killBatches();
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

  /** A run is in flight (full suite, save, ▶ Run …). */
  isRunning(): boolean {
    return this._activeRuns > 0;
  }

  /** Files finished / scheduled across the runs in flight. */
  progress(): { completed: number; total: number; failed: number } {
    return { ...this._progress };
  }

  /** The project this manager runs. */
  get projectRoot(): string {
    return this._projectRoot;
  }

  // ── Commands ───────────────────────────────────────────────────────────────

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
      const terms = this._terms(args.fileId);
      log.info(`${path.basename(args.fileId)} is not run by this project's ${terms.config} (${terms.configRulesShort}) — nothing to run`);
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
        ok = await this._adapterFor(args.fileId).runTestCase(
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
      const config = await this._adapterFor(filePath).getDebugConfig(
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

      // A framework's config changed: which files run, and how, may differ — start over.
      const changedConfig = await this._configFileOf(filePath, projectRoot);
      if (changedConfig) {
        if (token !== this._token) { return; }
        log.info(`Saved ${path.basename(filePath)} — the ${changedConfig.terms.config} changed, restarting the session (every test reruns)`);
        await this.start();
        return;
      }
      // Mixed project: what the file uses (vitest / @jest/globals imports) may have changed.
      this._services.fileChanged(filePath);

      // Jest's own list also knows tests named by a custom testRegex/testMatch.
      const isTestFile = this._adapterFor(filePath).isTestFile(filePath) || !!this._runnable?.has(runnableKey(filePath));
      if (isTestFile && !this._isRunnable(filePath) && !this._store.getFile(filePath)?.excluded) {
        // A test file created after Start is not in Jest's list yet — ask again
        // (a file already known to be excluded is not asked about every save).
        const name = this._terms(projectRoot).name;
        log.debug(`Saved ${path.basename(filePath)} — not in ${name}'s file list yet, asking ${name} again`);
        const files = this._store.getAllFiles().map((f) => f.filePath);
        if (!files.some((f) => runnableKey(f) === runnableKey(filePath))) { files.push(filePath); }
        this._runnable = toRunnableSet(await this._askForRunnable(projectRoot, runnableCacheKey(projectRoot, files, this._runnerSettings(projectRoot)), files));
        if (token !== this._token) { return; }
        if (!this._isRunnable(filePath)) { this._markExcluded([filePath]); }
      }
      if (isTestFile && !this._isRunnable(filePath)) {
        log.debug(`Saved ${path.basename(filePath)} — not run by this project's ${this._terms(projectRoot).config}, ignoring`);
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
        // The rerun is over, whichever way it went (trace-based, the
        // --findRelatedTests fallback, nothing depends on the file, or an
        // error): "stale — save to rerun" would otherwise stay until the next
        // Start. A whole-file traced rerun has already replaced the counters.
        if (!isTestFile && token === this._token) { this._coverageStore.clearStale(filePath); }
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
      this._killBatches();
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

  /**
   * The project goes away (workspace folders or projectRoot changed): stops
   * the session and every run in flight — also explicit ▶ Run runs started
   * without a session — and clears the store.
   */
  dispose(): void {
    this._token++;
    this._clearSaveTimers();
    this._killBatches();
    this._session?.stop();
    this._session = undefined;
    this._activeRuns = 0;
    this._fullSuiteStartedAt = undefined;
    this._store.clear();
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
    if (!this._services.isMixed()) {
      return this._runAffectedWith(this._services.servicesFor(projectRoot), sourceFilePath, projectRoot, token);
    }
    // Mixed project: each framework reruns its own test files that depend on
    // the source file (by its trace, else its related run — `jest
    // --findRelatedTests`, `vitest related`).
    const bundles = this._services.all();
    const ran = await Promise.all(bundles.map((s) =>
      this._runAffectedWith(s, sourceFilePath, projectRoot, token, (fp) => this._services.servicesFor(fp) === s)));
    return [...new Set(ran.flat())];
  }

  /**
   * {@link _runAffectedBySourceFile} for one framework. `owns` (mixed
   * projects) keeps the run to that framework's test files: results for
   * others — a related run may start them too — are ignored.
   */
  private async _runAffectedWith(
    services: FrameworkServices,
    sourceFilePath: string,
    projectRoot: string,
    token: number,
    owns?: (filePath: string) => boolean,
  ): Promise<string[]> {
    // A framework whose trace is off for this root (Vitest: see VitestTrace)
    // may have partial trace data: trust only its related run.
    const traceOff = services.traceOffReason?.(projectRoot);
    const affectedTestFiles = traceOff ? [] : this._traceStore
      .getAffectedTestFiles(sourceFilePath)
      .filter((fp) => this._isRunnable(fp) && (!owns || owns(fp)));

    if (affectedTestFiles.length === 0) {
      // No trace data — use jest --findRelatedTests as fallback. This runs Jest's
      // own static import-graph analysis: it finds test files that (transitively)
      // import the changed source file and reruns them whole. Less precise than
      // trace (whole file, not individual test cases) but correct as a safety net.
      log.debug(`${traceOff ? `No execution trace (${traceOff})` : 'No trace data'} for ${path.basename(sourceFilePath)} — using ${services.terms.relatedCommand}`);
      const batchRunner = services.batchRunner;
      if (batchRunner.runRelated) {
        return this._runRelatedBatch(batchRunner.runRelated.bind(batchRunner), sourceFilePath, projectRoot, token, owns);
      }
      this._addPlanned(1);
      const affectedPaths = await services.adapter.runRelatedTests(
        this._store,
        sourceFilePath,
        projectRoot,
        (msg) => this._outputChannel.appendLine(msg),
        owns,
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

    // Scoped reruns don't produce coverage data; onSave clears the stale flag
    // once this returns — the existing counters are still valid.
    return [...new Set([...filesToRunFull, ...individualCases.map((c) => c.filePath)])];
  }

  /**
   * The framework's own related run through its batch runner (Vitest:
   * `vitest related`): files show running as the framework starts them,
   * results stream, coverage is measured. Files that started without a
   * result go through the normal batch path (retry / split / plain run).
   */
  private async _runRelatedBatch(
    runRelated: NonNullable<IBatchRunner['runRelated']>,
    sourceFilePath: string,
    projectRoot: string,
    token: number,
    owns?: (filePath: string) => boolean,
  ): Promise<string[]> {
    const live = () => token === this._token;
    const mine = (fp: string) => !owns || owns(fp);
    const rawLog = (msg: string) => this._outputChannel.appendLine(msg);
    const hangTimeoutMs = 1000 * (vscode.workspace.getConfiguration('liveTestRunner').get<number>('hangTimeoutSeconds') ?? 300);
    const planned = new Set<string>();
    const plan = (fp: string) => {
      if (planned.has(fp)) { return; }
      planned.add(fp);
      if (!this._store.getFile(fp)) { this._store.fileDiscovered(fp, fp, vscode.workspace.asRelativePath(fp)); }
      this._addPlanned(1);
    };
    const markRunning = (fp: string) => {
      if (!mine(fp)) { return; }
      plan(fp);
      if (this._store.getFile(fp)?.status === 'running') { return; }
      this._store.markFileRunning(fp);
      this._notify('onFilesRerunning', [fp]);
    };
    const onFileDone = (fp: string, status: 'passed' | 'failed') => {
      if (!mine(fp)) { return; }
      plan(fp);
      this._fileFinished(status);
      this._notify('onFileResult', fp);
      this._refreshScopedLogs(fp);
    };
    let r: { ran: string[]; missing: string[] };
    try {
      r = await runRelated({
        sourceFiles: [sourceFilePath],
        projectRoot,
        traceStore: this._traceStore,
        store: this._store,
        applyFileResult: (fp, fr) => {
          if (!mine(fp)) { return; }
          if (this._store.getFile(fp)?.status !== 'running') { this._store.markFileRunning(fp); }
          this._adapterFor(fp).applyFileResult(this._store, fp, fr);
        },
        onFileDone,
        onFileStart: markRunning,
        onFileTimedOut: (fp, seconds) => {
          if (!mine(fp)) { return; }
          this._store.failFile(fp, hangMessage(seconds));
          onFileDone(fp, 'failed');
        },
        hangTimeoutMs,
        log: rawLog,
      });
    } catch (err) {
      log.error(`Running the tests related to ${path.basename(sourceFilePath)} failed`, err);
      return [];
    }
    const ran = r.ran.filter(mine);
    if (!live()) { return ran; }
    // Started but no result (crash, stalled batch): the normal batch path retries them. Their planned count moves there.
    const missing = r.missing.filter((fp) => mine(fp) && (this._isRunnable(fp) || this._store.getFile(fp)));
    if (missing.length > 0) {
      this._progress.total -= missing.length;
      await this._runFiles(missing, projectRoot, token);
    }
    return [...new Set([...ran, ...missing])];
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

      // Check if every test in the file is covered → full file run (a batch:
      // coverage is measured again). Skipped / todo tests never run, so they
      // never show up in a trace — they do not count against it.
      const allFileTests = this._store.getFileNodes(filePath).filter(n => n.type === 'test');
      const allTestFullNames = allFileTests.filter((n) => n.status !== 'skipped').map(n => n.fullName);
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
              ok = await this._adapterFor(run.filePath).runTestCase(
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
        status = await this._adapterFor(fp).runFile(this._store, fp, projectRoot, rawLog);
      } catch (err) {
        log.error(`${capitalise(this._terms(fp).plainRun)} fallback also failed for ${fp}`, err);
      }
      if (!live()) { return; }
      if (this._store.getFile(fp)?.status === 'running') {
        // No result at all. Either the file hung and was stopped, or Jest
        // could not run it — never leave it spinning (BUG-23).
        if (hangTimeoutMs > 0 && Date.now() - startedAt >= hangTimeoutMs * PLAIN_RUN_HANG_FACTOR) {
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
        // Batches never mix frameworks (see the queue below): the first file's is the batch's.
        const r = await this._services.servicesFor(batch[0]).batchRunner.runFiles({
          filePaths: batch,
          projectRoot,
          traceStore: this._traceStore,
          store: this._store,
          applyFileResult: (fp, fr) => {
            // Results replace the file's tests; mark them running first so
            // stale discovery placeholders are cleaned up.
            if (this._store.getFile(fp)?.status !== 'running') { this._store.markFileRunning(fp); }
            this._adapterFor(fp).applyFileResult(this._store, fp, fr);
          },
          onFileDone,
          onFileUpdated: (fp, status, wasStatus) => {
            if (status === 'failed' && wasStatus !== 'failed') { this._progress.failed++; this._postProgress(); }
            this._notify('onFileResult', fp);
            this._refreshScopedLogs(fp);
          },
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
        const terms = this._terms(batch[0]);
        log.warn(
          `No results from the ${terms.batchRun} for ${batch.length} file(s) — falling back to ${terms.plainRun}, one file at a time ` +
          `(${terms.fallbackLoss}). Files: ${shortList(batch)}`,
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
        log.warn(`No result for ${path.basename(missing[0])} — retrying it with ${this._terms(missing[0]).plainRun}`);
        await runPlain(missing[0]);
        return;
      }
      log.debug(`${missing.length} file(s) in a batch produced no result — splitting the batch and retrying`);
      const half = Math.ceil(missing.length / 2);
      await runBatch(missing.slice(0, half));
      await runBatch(missing.slice(half));
    };

    // Build batch queue up-front and drain it with CONCURRENCY workers. In a
    // mixed project each batch holds one framework's files (phase 8).
    const byFramework = new Map<FrameworkServices, string[]>();
    for (const fp of filePaths) {
      const s = this._services.servicesFor(fp);
      const list = byFramework.get(s);
      if (list) { list.push(fp); } else { byFramework.set(s, [fp]); }
    }
    const batchQueue: string[][] = [];
    for (const files of byFramework.values()) {
      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        batchQueue.push(files.slice(i, i + BATCH_SIZE));
      }
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
    const split = this._services.isMixed() ? this._frameworkSplit() : '';
    this._updateStatusBar(
      (summary.failed > 0
        ? `❌ ${summary.failed} failed, ${summary.passed} passed`
        : `✅ ${summary.passed} passed`) + split,
    );
    this._discovery.pruneGhostFiles();
  }

  /** Mixed projects: " · Jest 12 · Vitest 8" — tests per framework (files not run excluded). */
  private _frameworkSplit(): string {
    const counts = new Map<string, number>();
    for (const f of this._store.getAllFiles()) {
      if (f.excluded) { continue; }
      const name = this._services.servicesFor(f.filePath).displayName;
      counts.set(name, (counts.get(name) ?? 0) + this._store.getTestNodesForFiles([f.fileId]).length);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => ` · ${n} ${c}`).join('');
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
  private async _listRunnableFiles(projectRoot: string, discovered: string[]): Promise<string[] | undefined> {
    const startedAt = Date.now();
    try {
      const rawLog = (msg: string) => this._outputChannel.appendLine(msg);
      const listed = await this._services.listTestFiles(projectRoot, discovered, rawLog);
      const files = listed.files;
      this._groups = listed.groups;
      this._frameworks = listed.frameworks;
      if (files.length === 0) { return undefined; }
      log.debug(`${this._terms(projectRoot).listCommand}: ${files.length} file(s) in ${secondsSince(startedAt)}`);
      return files;
    } catch (err) {
      const terms = this._terms(projectRoot);
      log.warn(`Could not ask ${terms.name} which files it runs (${terms.listCommand}) — running every discovered test file`, err);
      return undefined;
    }
  }

  /**
   * The runnable files for Start: the last session's list when no test file
   * and no Jest config changed since, otherwise Jest's answer (a full Jest
   * startup — 20 s on a 200-file project, and nothing runs until it is in).
   */
  private async _runnableFiles(projectRoot: string, discovered: string[]): Promise<string[] | undefined> {
    const key = runnableCacheKey(projectRoot, discovered, this._runnerSettings(projectRoot));
    const entry = this._runnableCache.readEntry(projectRoot, key);
    if (entry) {
      const cached = entry.files;
      this._groups = entry.groups;
      this._frameworks = entry.frameworks;
      this._services.restore(entry);
      log.debug(`Runnable test files: ${cached.length} remembered from the last session (no test or config file changed)`);
      // Lists saved by older versions may hold Jest's realpath'd spelling.
      return cached.map(fromRunnerPath);
    }
    this._updateStatusBar(`Asking ${this._services.servicesFor(projectRoot).displayName} which files it runs…`);
    return this._askForRunnable(projectRoot, key, discovered);
  }

  /** Asks the framework(s) for the runnable files and remembers the answer under `key`. */
  private async _askForRunnable(projectRoot: string, key: string, discovered: string[]): Promise<string[] | undefined> {
    const files = await this._listRunnableFiles(projectRoot, discovered);
    if (!files) { return undefined; }
    try {
      this._runnableCache.write(projectRoot, key, files, this._groups, this._frameworks);
    } catch (err) {
      log.debug(`Could not remember the runnable test files — the next Start asks ${this._terms(projectRoot).name} again (${(err as Error).message})`);
    }
    return files;
  }

  /** Settings that change how the framework is called, and so which files it lists. */
  private _runnerSettings(projectRoot: string): string {
    return this._services.fingerprint(projectRoot);
  }

  /** The framework whose config file `filePath` is, if any (every framework of the project). */
  private async _configFileOf(filePath: string, projectRoot: string): Promise<FrameworkServices | undefined> {
    for (const s of this._services.all()) {
      if (await s.isConfigFile(filePath, projectRoot)) { return s; }
    }
    return undefined;
  }

  private _isRunnable(filePath: string): boolean {
    return !this._runnable || this._runnable.has(runnableKey(filePath));
  }

  private _markExcluded(files: string[]): void {
    if (files.length === 0) { return; }
    const terms = this._terms(files[0]);
    for (const fp of files) {
      this._store.markFileExcluded(fp, `Not run: this project's ${terms.config} excludes this file (${terms.configRules}).`);
    }
    log.info(`${files.length} test file(s) are not run by this project's ${terms.config} and are shown as skipped: ${shortList(files)}`);
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

  private _getProjectRoot(): string {
    registerProjectRoot(this._projectRoot);
    return this._projectRoot;
  }

  private _updateStatusBar(text: string): void {
    this._statusBar.text = `Live Tests: ${text}`;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
