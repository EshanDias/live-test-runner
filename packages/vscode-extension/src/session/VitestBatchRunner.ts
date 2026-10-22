/**
 * VitestBatchRunner — runs a batch of test files in one Vitest process and
 * streams results per file.
 *
 * The runner's Vitest reporter writes live events (see the runner's
 * framework/vitestReporter.ts): `file-start` (the file shows running only
 * now — Vitest runs a batch's files in parallel workers, not all at once),
 * `test-start` / `test-end` heartbeats, console output and failures, and
 * `file-end` with the file's result, which is applied right away.
 *
 * Hangs: the limit applies to one test (a heartbeat without its end), as in
 * Jest's batch runner — a file that is merely slow to load is never stopped.
 * The hanging file is failed; the batch's other unfinished files come back
 * as missing and SessionManager retries them. A worker stuck in a
 * synchronous loop may never send its "test started" update (Vitest batches
 * them), so a batch with no event at all for hangTimeoutMs ×
 * PLAIN_RUN_HANG_FACTOR is stopped too and its unfinished files retried one
 * by one — the single-file limit then pins down the hanging one.
 *
 * Coverage: Vitest's own (v8 / istanbul provider), as istanbul JSON in a
 * per-batch folder of the session dir, mapped into the CoverageStore when
 * the batch ends. Off when the provider package is not installed (the
 * runner says so once). No execution trace (phase 9).
 *
 * runRelated: `vitest related <src> --run` through the same live path — the
 * test files are only known when Vitest starts them, so each is claimed on
 * its `file-start`.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CommandRunner,
  Executor,
  FileRunResult,
  VitestEvent,
  VitestRunner,
  applyVitestEvents,
  fromRunnerPath,
  liveFileResult,
  tail,
} from '@live-test-runner/runner';
import { BatchRunOptions, IBatchRunner, RelatedRunOptions } from './IBatchRunner';
import { runnableKey } from './RunnableFiles';
import { CoverageStore } from '../coverage/CoverageStore';
import { applyIstanbulCoverage } from '../coverage/istanbulCoverage';
import { CoverageScope, coverageScopeOf, defaultCoverageScope } from '../coverage/coverageScope';
import { IProjectConfig } from './IProjectConfig';
import { PLAIN_RUN_HANG_FACTOR } from '../constants';
import { logger } from '../utils/logger';

const log = logger.scope('Vitest');

/** No file finished for this long → say what the batch is doing. */
const SLOW_BATCH_WARN_MS = 60_000;

export class VitestBatchRunner implements IBatchRunner {
  private static _batchSeq = 0;
  /** Processes of batches still running — for kill(). */
  private readonly _running = new Set<Executor>();
  /** file → the batch whose result counts for it (the newest run of the file). */
  private readonly _owner = new Map<string, string>();
  private _killed = false;
  /** Bumped by kill(): events of batches started before it are dropped. */
  private _generation = 0;

  /**
   * @param _createRunner a fresh VitestRunner for the project (reads the settings)
   * @param _coverage where measured coverage goes, the session dir for its files, and the
   *   project config whose coverage settings decide which files count (none: no coverage)
   */
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
  }

  async runFiles(options: BatchRunOptions): Promise<{ missing: string[] }> {
    if (options.filePaths.length === 0 || this._killed) { return { missing: [] }; }
    return this._run(options);
  }

  async runRelated(options: RelatedRunOptions): Promise<{ ran: string[]; missing: string[] }> {
    if (options.sourceFiles.length === 0 || this._killed) { return { ran: [], missing: [] }; }
    const ran: string[] = [];
    let missing: string[] = [];
    // One process per source file: `vitest related` takes several, but a single file keeps the log readable and is the common case.
    for (const src of options.sourceFiles) {
      if (this._killed) { break; }
      const r = await this._run({ ...options, filePaths: [] }, src);
      ran.push(...r.ran);
      missing = [...missing, ...r.missing];
    }
    return { ran: [...new Set(ran)], missing: [...new Set(missing)] };
  }

  /** A batch of `filePaths`, or (with `related`) of whatever test files depend on that source file. */
  private async _run(options: BatchRunOptions, related?: string): Promise<{ ran: string[]; missing: string[] }> {
    const { projectRoot, applyFileResult, onFileDone } = options;
    /** The batch's files: given up front, or claimed as Vitest starts them (related). */
    const filePaths = [...options.filePaths];
    const batch = `v${++VitestBatchRunner._batchSeq}`;
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
    const claim = (fp: string) => {
      if (!related || filePaths.includes(fp)) { return; }
      filePaths.push(fp);
      this._owner.set(fp, batch);
    };
    const release = () => { for (const fp of filePaths) { if (owns(fp)) { this._owner.delete(fp); } } };

    // Vitest reports real paths — map them back to the caller's keys.
    const keyByNorm = new Map(filePaths.map((fp) => [runnableKey(fp), fp]));
    const toKey = (p: string) => keyByNorm.get(runnableKey(p))
      ?? options.store.findFileKey(fromRunnerPath(p))
      ?? path.normalize(fromRunnerPath(p));

    const runner = this._createRunner(rawLog) as VitestRunner;
    let live: Awaited<ReturnType<VitestRunner['liveCommand']>>;
    try {
      runner.setProjectRoot(projectRoot);
      const coverageDir = this._coverage ? path.join(this._coverage.sessionDir, 'vitest-coverage', batch) : undefined;
      live = await runner.liveCommand(filePaths, { coverageDir, related });
    } catch (err) {
      log.error(`${batch}: could not build the Vitest command for ${projectRoot}`, err);
      release();
      return { ran: [], missing: [] };
    }

    const received = new Set<string>();
    /** Console output and failures per file, until its result arrives. */
    const pending = new Map<string, VitestEvent[]>();
    /** The test each file is running now — what the hang limit measures. */
    const runningTests = new Map<string, { name?: string; at: number }>();
    let timedOut: { file: string; seconds: number; test?: string } | undefined;
    let stalled = false;
    let lastEventAt = Date.now();
    const executor = new Executor(rawLog);

    const onRecord = (raw: unknown) => {
      if (generation !== this._generation) { return; } // stopped: a dying Vitest's events are dropped
      lastEventAt = Date.now();
      const ev = raw as VitestEvent;
      if (!ev || !ev.file) { return; }
      const fp = toKey(ev.file);
      try {
        switch (ev.ev) {
          case 'file-start':
            claim(fp);
            if (owns(fp)) { options.onFileStart?.(fp); }
            break;
          case 'test-start':
            runningTests.set(fp, { name: ev.name, at: Date.now() });
            break;
          case 'test-end':
            runningTests.delete(fp);
            break;
          case 'log':
          case 'error': {
            const list = pending.get(fp) ?? [];
            list.push(ev);
            pending.set(fp, list);
            break;
          }
          case 'file-end': {
            claim(fp);
            runningTests.delete(fp);
            const fr = liveFileResult(ev);
            if (!fr) { break; }
            const result = applyVitestEvents(
              { passed: fr.status === 'passed', numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, fileResults: [{ ...fr, testFilePath: fp }], errors: [] },
              (pending.get(fp) ?? []).map((e) => ({ ...e, file: fp })),
              projectRoot,
            );
            pending.delete(fp);
            const fileResult: FileRunResult = result.fileResults[0];
            received.add(fp);
            if (!owns(fp)) {
              log.debug(`${batch}: ignoring the result for ${path.basename(fp)} — a newer run of it has started`);
              break;
            }
            applyFileResult(fp, fileResult);
            onFileDone(fp, fileResult.status);
            break;
          }
        }
      } catch (err) {
        log.error(`${batch}: could not apply the ${ev.ev} event for ${fp}`, err);
      }
    };

    // Watchdog: one test running too long is a hang; no file finishing for a
    // long time is worth a line saying what the batch is on.
    let lastReceived = 0;
    let lastProgressAt = Date.now();
    let nextWarnAt = Date.now() + SLOW_BATCH_WARN_MS;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (hangTimeoutMs > 0 && !timedOut && !stalled && now - lastEventAt > hangTimeoutMs * PLAIN_RUN_HANG_FACTOR) {
        stalled = true;
        log.warn(
          `${batch}: no progress from Vitest for ${Math.round((now - lastEventAt) / 1000)}s with ${filePaths.length - received.size} file(s) unfinished — ` +
          'stopping the batch (probably a hanging test that blocks its worker). Its unfinished files are retried one by one. ' +
          'Change the limit with liveTestRunner.hangTimeoutSeconds.',
        );
        executor.kill();
        return;
      }
      if (hangTimeoutMs > 0 && !timedOut && !stalled) {
        for (const [file, t] of runningTests) {
          if (received.has(file) || now - t.at <= hangTimeoutMs) { continue; }
          timedOut = { file, seconds: Math.round((now - t.at) / 1000), test: t.name };
          log.warn(
            `${batch}: ${path.basename(file)} has run for ${timedOut.seconds}s without finishing` +
            `${t.name ? ` (test "${t.name}")` : ''} — stopping it ` +
            '(probably a hanging test: an infinite loop or a promise that never resolves). ' +
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
      const busy = [...runningTests.keys()].map((f) => path.basename(f));
      log.warn(
        `${batch}: no file has finished in ${Math.round((now - lastProgressAt) / 1000)}s — ${received.size}/${filePaths.length} done` +
        `${busy.length ? `, running ${busy.join(', ')}` : ''}. Slow tests keep making progress; if this repeats for the same file, a test there is probably hanging.`,
      );
    }, 2_000);

    log.debug(related
      ? `${batch}: running the tests related to ${path.basename(related)}`
      : `${batch}: running ${filePaths.length} file(s) — ${filePaths.map((p) => path.basename(p)).join(', ')}`);
    this._running.add(executor);
    let stderr = '';
    try {
      const result = await executor.runWithReporterPolling(live.command, live.eventsFile, onRecord);
      stderr = result.stderr + '\n' + result.stdout;
    } catch (err) {
      log.error(`${batch}: Vitest run failed`, err);
    } finally {
      clearInterval(watchdog);
      this._running.delete(executor);
      for (const f of [live.eventsFile, live.resultFile]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    }

    // Coverage of whatever ran (not after Stop — those results are dropped too).
    if (live.coverageFile && this._coverage && generation === this._generation) {
      const scope = this._coverage.projectConfig
        ? await coverageScopeOf(this._coverage.projectConfig, projectRoot)
        : defaultCoverageScope(projectRoot);
      if (generation === this._generation) { this._applyCoverage(live.coverageFile, projectRoot, batch, scope); }
    }

    const stopped = generation !== this._generation;
    if (stopped) {
      log.debug(`${batch}: stopped by the user after ${seconds(startedAt)}`);
    } else if (timedOut) {
      log.debug(`${batch}: stopped after ${seconds(startedAt)} — ${path.basename(timedOut.file)} hung`);
      if (owns(timedOut.file)) {
        received.add(timedOut.file); // failed as hung below — never retried
        options.onFileTimedOut?.(timedOut.file, timedOut.seconds);
      }
    } else if (stalled) {
      log.debug(`${batch}: stopped after ${seconds(startedAt)} — no progress`);
    } else if (received.size === 0 && related) {
      log.debug(`${batch}: no test depends on ${path.basename(related)} (${seconds(startedAt)})`);
    } else if (received.size === 0) {
      log.warn(`${batch}: Vitest returned no results for ${filePaths.length} file(s). Vitest said:\n${tail(stderr)}`);
    } else {
      log.debug(`${batch}: done in ${seconds(startedAt)} — ${received.size}/${filePaths.length} file(s) reported`);
    }
    const missing = stopped ? [] : filePaths.filter((fp) => owns(fp) && !received.has(fp));
    const ran = filePaths.filter((fp) => received.has(fp));
    release();
    return { ran, missing };
  }

  private _applyCoverage(coverageFile: string, projectRoot: string, batch: string, scope: CoverageScope): void {
    const dir = path.dirname(coverageFile);
    try {
      if (!fs.existsSync(coverageFile)) {
        log.debug(`${batch}: Vitest wrote no coverage (no source file was loaded, or the run was stopped)`);
        return;
      }
      const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
      const { measured, excluded } = applyIstanbulCoverage(
        coverage, this._coverage!.store, path.join(this._coverage!.sessionDir, 'vitest-manifests'), projectRoot,
        (fp) => scope.counts(fp),
      );
      log.debug(`${batch}: coverage — ${measured} file(s) measured, ${excluded} excluded`);
    } catch (err) {
      log.warn(`${batch}: could not read Vitest's coverage (${coverageFile})`, err);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    }
  }
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}
