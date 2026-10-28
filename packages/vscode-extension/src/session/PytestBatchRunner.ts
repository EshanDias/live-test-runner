/**
 * PytestBatchRunner — runs a batch of test files in one pytest process and
 * streams results per file.
 *
 * Our plugin (runner `framework/pytest/ltr_pytest.py`) writes live events:
 * `file-start` (the file shows running only now — pytest runs a batch's
 * files one after another), `test-start` / `test-end` heartbeats, and
 * `file-end` with the file's finished result (per-test output included),
 * applied right away.
 *
 * Hangs: the limit applies to one test (a heartbeat without its end), as for
 * Jest and Vitest — a slow import is never stopped. The hanging file is
 * failed; the batch's other unfinished files come back as missing and
 * SessionManager retries them.
 *
 * Coverage: the plugin measures with the project's coverage.py and settings
 * into a per-batch folder of the session dir, written istanbul-shaped, and
 * mapped into the CoverageStore when the batch ends. Each test runs in its
 * own coverage context; those become trace records (the same as Jest's and
 * Vitest's) in the ExecutionTraceStore: covering tests in the hover, and a
 * saved source file reruns exactly the tests that ran it (by node id). Without the `coverage`
 * package the tests still run; one INFO line per project says why there is
 * no coverage.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CommandRunner,
  Executor,
  FileRunResult,
  PytestRunner,
  fromRunnerPath,
  pytestExitReason,
  pytestSettings,
  tail,
} from '@live-test-runner/runner';
import { BatchRunOptions, IBatchRunner, RelatedRunOptions } from './IBatchRunner';
import { PythonImportGraph, pythonImportRoots } from './pythonImports';
import { runnableKey } from './RunnableFiles';
import { CoverageStore } from '../coverage/CoverageStore';
import { applyIstanbulCoverage } from '../coverage/istanbulCoverage';
import { coverageScopeOf } from '../coverage/coverageScope';
import { IProjectConfig } from './IProjectConfig';
import { pythonInterpreters } from '../python/PythonInterpreters';
import { applyTraceRecords, readTraceLines } from './traceRecords';
import { logger } from '../utils/logger';

const log = logger.scope('pytest');

/** No file finished for this long → say what the batch is doing. */
const SLOW_BATCH_WARN_MS = 60_000;

interface PytestEvent {
  ev: string;
  file?: string;
  nodeid?: string;
  name?: string;
  result?: FileRunResult;
  capture?: string;
  reason?: string;
  exit?: number;
  coverage?: boolean;
  coverageError?: string;
}

export class PytestBatchRunner implements IBatchRunner {
  private static _batchSeq = 0;
  private readonly _running = new Set<Executor>();
  /** file → the batch whose result counts for it (the newest run of the file). */
  private readonly _owner = new Map<string, string>();
  private _killed = false;
  private _generation = 0;
  /** Roots already told about (capture off, no coverage) — once each per session. */
  private readonly _told = new Set<string>();

  constructor(
    private readonly _createRunner: (rawLog: (msg: string) => void) => CommandRunner,
    private readonly _coverage?: { store: CoverageStore; sessionDir: string; projectConfig?: IProjectConfig },
  ) {}

  kill(): void {
    this._killed = true;
    this._generation++;
    for (const executor of this._running) { executor.kill(); }
    this._running.clear();
    this._owner.clear();
  }

  reset(): void {
    this._killed = false;
    this._told.clear();
  }

  async runFiles(options: BatchRunOptions): Promise<{ missing: string[] }> {
    if (options.filePaths.length === 0 || this._killed) { return { missing: [] }; }
    // No usable Python: said once (notification + WARN); the files get no result.
    if (!(await this._ready(options.projectRoot))) { return { missing: [] }; }
    const r = await this._run(options);
    return { missing: r.missing };
  }

  /** Import graphs per project root (files re-read when they change). */
  private readonly _graphs = new Map<string, PythonImportGraph>();

  /**
   * The tests of a saved source file when covering tests do not know it yet
   * (before its first coverage run, or no coverage package): every test file
   * that imports it, directly or through project modules, runs whole — in one
   * batch, with coverage, so the covering tests are known from then on.
   */
  async runRelated(options: RelatedRunOptions): Promise<{ ran: string[]; missing: string[] }> {
    if (options.sourceFiles.length === 0 || this._killed) { return { ran: [], missing: [] }; }
    const { projectRoot } = options;
    let graph = this._graphs.get(projectRoot);
    if (!graph) {
      graph = new PythonImportGraph(pythonImportRoots(projectRoot, pytestSettings(projectRoot).pythonpath));
      this._graphs.set(projectRoot, graph);
    }
    const tests = options.store.getAllFiles().filter((f) => !f.excluded).map((f) => f.filePath);
    const dependents = new Set<string>();
    for (const src of options.sourceFiles) {
      for (const t of graph.dependents(src, tests)) { dependents.add(t); }
    }
    if (dependents.size === 0) {
      log.debug(`No test file imports ${options.sourceFiles.map((f) => path.basename(f)).join(', ')}`);
      return { ran: [], missing: [] };
    }
    log.debug(`Import graph: ${dependents.size} test file(s) import ${options.sourceFiles.map((f) => path.basename(f)).join(', ')}`);
    if (!(await this._ready(projectRoot))) { return { ran: [], missing: [] }; }
    return this._run({ ...options, filePaths: [...dependents] });
  }

  private async _ready(projectRoot: string): Promise<boolean> {
    try {
      await pythonInterpreters().ensure(projectRoot);
      return !this._killed;
    } catch (err) {
      log.debug(`No usable Python for ${projectRoot}: ${(err as Error).message}`);
      return false;
    }
  }

  private async _run(options: BatchRunOptions): Promise<{ ran: string[]; missing: string[] }> {
    const { projectRoot, applyFileResult, onFileDone } = options;
    const filePaths = [...options.filePaths];
    const batch = `p${++PytestBatchRunner._batchSeq}`;
    const generation = this._generation;
    const startedAt = Date.now();
    const hangTimeoutMs = options.hangTimeoutMs ?? 0;
    const rawLog = options.log ?? (() => {});

    for (const fp of filePaths) {
      const prev = this._owner.get(fp);
      if (prev) { log.debug(`${batch}: ${path.basename(fp)} is also still running in ${prev} — only this newer run's result will be used`); }
      this._owner.set(fp, batch);
    }
    const owns = (fp: string) => this._owner.get(fp) === batch;
    const release = () => { for (const fp of filePaths) { if (owns(fp)) { this._owner.delete(fp); } } };

    // Python reports real paths (macOS /private/var, resolved symlinks) — map them back to the caller's keys.
    const keyByNorm = new Map(filePaths.map((fp) => [runnableKey(fp), fp]));
    const toKey = (p: string) => keyByNorm.get(runnableKey(p))
      ?? options.store.findFileKey(fromRunnerPath(p))
      ?? path.normalize(fromRunnerPath(p));

    const runner = this._createRunner(rawLog) as PytestRunner;
    let live: Awaited<ReturnType<PytestRunner['liveCommand']>>;
    const coverageDir = this._coverage ? path.join(this._coverage.sessionDir, 'pytest-coverage', batch) : undefined;
    try {
      runner.setProjectRoot(projectRoot);
      live = await runner.liveCommand(filePaths, { coverageDir });
    } catch (err) {
      log.error(`${batch}: could not build the pytest command for ${projectRoot}`, err);
      release();
      return { ran: [], missing: [] };
    }

    const received = new Set<string>();
    const runningTests = new Map<string, { name?: string; at: number }>();
    let timedOut: { file: string; seconds: number; test?: string } | undefined;
    let exitStatus: number | undefined;
    const executor = new Executor(rawLog);

    const onRecord = (raw: unknown) => {
      if (generation !== this._generation) { return; } // stopped: a dying pytest's events are dropped
      const ev = raw as PytestEvent;
      if (!ev || typeof ev.ev !== 'string') { return; }
      try {
        switch (ev.ev) {
          case 'config':
            this._onConfig(projectRoot, ev);
            return;
          case 'coverage-off':
            this._tellOnce(projectRoot, 'coverage', `No coverage for ${path.basename(projectRoot)}: ${ev.reason ?? 'coverage.py is not available'} (tests still run).`);
            return;
          case 'session-end':
            exitStatus = ev.exit;
            return;
        }
        if (!ev.file) { return; }
        const fp = toKey(ev.file);
        switch (ev.ev) {
          case 'file-start':
            if (owns(fp)) { options.onFileStart?.(fp); }
            break;
          case 'test-start':
            runningTests.set(fp, { name: ev.name, at: Date.now() });
            break;
          case 'test-end':
            runningTests.delete(fp);
            break;
          case 'file-end': {
            runningTests.delete(fp);
            if (!ev.result) { break; }
            received.add(fp);
            if (!owns(fp)) {
              // pytest reports files of a test it was not asked for only in odd setups (a test file imported by another).
              if (!keyByNorm.has(runnableKey(ev.file))) { log.debug(`${batch}: ignoring a result for ${path.basename(fp)} — not part of this batch`); }
              break;
            }
            const fileResult: FileRunResult = { ...ev.result, testFilePath: fp };
            applyFileResult(fp, fileResult);
            onFileDone(fp, fileResult.status);
            break;
          }
        }
      } catch (err) {
        log.error(`${batch}: could not apply the ${ev.ev} event`, err);
      }
    };

    let lastReceived = 0;
    let lastProgressAt = Date.now();
    let nextWarnAt = Date.now() + SLOW_BATCH_WARN_MS;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (hangTimeoutMs > 0 && !timedOut) {
        for (const [file, t] of runningTests) {
          if (now - t.at <= hangTimeoutMs) { continue; }
          timedOut = { file, seconds: Math.round((now - t.at) / 1000), test: t.name };
          log.warn(
            `${batch}: ${path.basename(file)} has run for ${timedOut.seconds}s without finishing` +
            `${t.name ? ` (test "${t.name}")` : ''} — stopping it ` +
            '(probably a hanging test: an infinite loop, a blocking call or a deadlock). ' +
            'The rest of the batch is retried. Change the limit with liveTestRunner.hangTimeoutSeconds.',
          );
          executor.kill();
          return;
        }
      }
      if (received.size !== lastReceived) {
        lastReceived = received.size;
        lastProgressAt = now;
        nextWarnAt = Math.max(nextWarnAt, now + SLOW_BATCH_WARN_MS);
        return;
      }
      if (now < nextWarnAt) { return; }
      nextWarnAt = now + SLOW_BATCH_WARN_MS * 2;
      const busy = [...runningTests.entries()].map(([f, t]) => `${path.basename(f)}${t.name ? ` (${t.name})` : ''}`);
      log.warn(
        `${batch}: no file has finished in ${Math.round((now - lastProgressAt) / 1000)}s — ${received.size}/${filePaths.length} done` +
        `${busy.length ? `, running ${busy.join(', ')}` : ''}. Slow tests keep making progress; if this repeats for the same test, it probably hangs.`,
      );
    }, 2_000);

    log.debug(`${batch}: running ${filePaths.length} file(s) — ${filePaths.map((p) => path.basename(p)).join(', ')}`);
    this._running.add(executor);
    let output = '';
    try {
      const result = await executor.runWithReporterPolling(live.command, live.eventsFile, onRecord);
      output = `${result.stderr}\n${result.stdout}`;
    } catch (err) {
      log.error(`${batch}: pytest run failed`, err);
    } finally {
      clearInterval(watchdog);
      this._running.delete(executor);
      for (const f of [live.eventsFile, live.resultFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    }

    if (live.coverageFile && this._coverage && generation === this._generation) {
      // Covering tests first (the coverage folder is removed with the coverage).
      const traceFile = path.join(path.dirname(live.coverageFile), 'trace.jsonl');
      if (fs.existsSync(traceFile)) {
        try {
          const summary = applyTraceRecords(readTraceLines([traceFile]), options.traceStore, toKey);
          log.debug(`${batch}: covering tests — ${summary.tests} test(s) across ${summary.files} file(s)`);
        } catch (err) {
          log.warn(`${batch}: could not read the covering tests`, err);
        }
      }
      await this._applyCoverage(live.coverageFile, projectRoot, batch);
    } else if (coverageDir) {
      try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch { /* gone */ }
    }

    const stopped = generation !== this._generation;
    if (stopped) {
      log.debug(`${batch}: stopped by the user after ${seconds(startedAt)}`);
    } else if (timedOut) {
      log.debug(`${batch}: stopped after ${seconds(startedAt)} — ${path.basename(timedOut.file)} hung`);
      if (owns(timedOut.file)) {
        received.add(timedOut.file);
        options.onFileTimedOut?.(timedOut.file, timedOut.seconds);
      }
    } else if (received.size === 0) {
      const reason = pytestExitReason(exitStatus);
      log.warn(`${batch}: pytest returned no results for ${filePaths.length} file(s)${reason ? ` — ${reason}` : ''}. pytest said:\n${tail(output)}`);
    } else {
      const reason = pytestExitReason(exitStatus);
      if (reason) { log.warn(`${batch}: ${reason}. pytest said:\n${tail(output, 15)}`); }
      log.debug(`${batch}: done in ${seconds(startedAt)} — ${received.size}/${filePaths.length} file(s) reported`);
    }
    const missing = stopped ? [] : filePaths.filter((fp) => owns(fp) && !received.has(fp));
    const ran = filePaths.filter((fp) => received.has(fp));
    release();
    return { ran, missing };
  }

  private _onConfig(projectRoot: string, ev: PytestEvent): void {
    if (ev.capture === 'no') {
      this._tellOnce(projectRoot, 'capture', `pytest output capturing is off for ${path.basename(projectRoot)} (-s / --capture=no in addopts or liveTestRunner.pytestArgs) — test output appears in the Test Output channel only, not per test.`, 'warn');
    }
  }

  private _tellOnce(projectRoot: string, what: string, message: string, level: 'info' | 'warn' = 'info'): void {
    const key = `${what}\0${projectRoot}`;
    if (this._told.has(key)) { return; }
    this._told.add(key);
    log[level](message);
  }

  private async _applyCoverage(coverageFile: string, projectRoot: string, batch: string): Promise<void> {
    const dir = path.dirname(coverageFile);
    try {
      if (!fs.existsSync(coverageFile)) {
        log.debug(`${batch}: no coverage written (nothing measured, or the run was stopped)`);
        return;
      }
      const scope = await coverageScopeOf(this._coverage!.projectConfig ?? { coverageScope: async () => undefined }, projectRoot);
      const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
      const { measured, excluded } = applyIstanbulCoverage(
        coverage, this._coverage!.store, path.join(this._coverage!.sessionDir, 'pytest-manifests'), projectRoot,
        (fp) => scope.counts(fp),
      );
      log.debug(`${batch}: coverage — ${measured} file(s) measured, ${excluded} excluded`);
    } catch (err) {
      log.warn(`${batch}: could not read the coverage (${coverageFile})`, err);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    }
  }
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}
