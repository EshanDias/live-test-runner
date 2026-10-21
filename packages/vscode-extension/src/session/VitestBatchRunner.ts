/**
 * VitestBatchRunner — runs a batch of test files in one Vitest process.
 *
 * Phase-2 shape: the batch's JSON result is read when Vitest exits and then
 * applied file by file (no per-file streaming, no trace, no coverage — those
 * are the live reporter (task 4.1), trace (9.x) and coverage (5.x) work).
 * Vitest runs a batch's files in parallel, so every file is shown running
 * when the batch starts.
 *
 * Hangs: there is no per-test heartbeat yet, so the whole batch gets
 * hangTimeoutMs × PLAIN_RUN_HANG_FACTOR. A batch stopped by that limit
 * returns its files as missing; SessionManager then retries them one by one
 * with the single-file limit, which pins down the hanging file.
 */
import * as path from 'path';
import { CommandRunner, FileRunResult, fromRunnerPath } from '@live-test-runner/runner';
import { BatchRunOptions, IBatchRunner } from './IBatchRunner';
import { runnableKey } from './RunnableFiles';
import { PLAIN_RUN_HANG_FACTOR } from '../constants';
import { logger } from '../utils/logger';

const log = logger.scope('Vitest');

export class VitestBatchRunner implements IBatchRunner {
  private static _batchSeq = 0;
  /** Runners of batches still running — for kill(). */
  private readonly _running = new Set<CommandRunner>();
  /** file → the batch whose result counts for it (the newest run of the file). */
  private readonly _owner = new Map<string, string>();
  private _killed = false;
  /** Bumped by kill(): results of batches started before it are dropped. */
  private _generation = 0;

  /** @param _createRunner a fresh VitestRunner for the project (reads the command setting) */
  constructor(private readonly _createRunner: (rawLog: (msg: string) => void) => CommandRunner) {}

  kill(): void {
    this._killed = true;
    this._generation++;
    for (const runner of this._running) { runner.killProcesses(); }
    this._running.clear();
    this._owner.clear();
  }

  reset(): void {
    this._killed = false;
  }

  async runFiles(options: BatchRunOptions): Promise<{ missing: string[] }> {
    const { filePaths, projectRoot, applyFileResult, onFileDone } = options;
    if (filePaths.length === 0 || this._killed) { return { missing: [] }; }
    const batch = `v${++VitestBatchRunner._batchSeq}`;
    const generation = this._generation;
    const startedAt = Date.now();

    for (const fp of filePaths) { this._owner.set(fp, batch); }
    const owns = (fp: string) => this._owner.get(fp) === batch;
    const release = () => { for (const fp of filePaths) { if (owns(fp)) { this._owner.delete(fp); } } };

    // Vitest may spell a path differently (symlinks resolved, separators,
    // drive-letter case) — map results back to the caller's keys.
    const keyByNorm = new Map(filePaths.map((fp) => [runnableKey(fp), fp]));
    const toKey = (p: string) => keyByNorm.get(runnableKey(p)) ?? path.normalize(fromRunnerPath(p));

    const runner = this._createRunner(options.log ?? (() => {}));
    runner.setProjectRoot(projectRoot);
    this._running.add(runner);
    for (const fp of filePaths) { options.onFileStart?.(fp); }

    const limitMs = (options.hangTimeoutMs ?? 0) * PLAIN_RUN_HANG_FACTOR;
    let timedOut = false;
    const timer = limitMs > 0
      ? setTimeout(() => {
          timedOut = true;
          log.warn(
            `${batch}: ${filePaths.length} file(s) ran for ${Math.round(limitMs / 1000)}s without finishing — stopping the batch ` +
            '(probably a hanging test). Its files are retried one by one. Change the limit with liveTestRunner.hangTimeoutSeconds.',
          );
          runner.killProcesses();
        }, limitMs)
      : undefined;

    log.debug(`${batch}: running ${filePaths.length} file(s) — ${filePaths.map((p) => path.basename(p)).join(', ')}`);
    const received = new Set<string>();
    try {
      const result = await runner.runTestFilesJson(filePaths);
      if (generation !== this._generation) {
        log.debug(`${batch}: stopped by the user after ${seconds(startedAt)}`);
      } else if (!timedOut) {
        const byFile = new Map<string, FileRunResult>();
        for (const fr of result.fileResults) {
          const key = toKey(fr.testFilePath);
          byFile.set(key, { ...fr, testFilePath: key });
        }
        for (const [fp, fr] of byFile) {
          received.add(fp);
          if (!owns(fp)) {
            log.debug(`${batch}: ignoring the result for ${path.basename(fp)} — a newer run of it has started`);
            continue;
          }
          try {
            applyFileResult(fp, fr);
            onFileDone(fp, fr.status);
          } catch (err) {
            log.error(`${batch}: could not apply results for ${fp}`, err);
          }
        }
        if (received.size === 0) {
          log.warn(`${batch}: Vitest returned no results for ${filePaths.length} file(s)${result.errors[0] ? ` — ${firstLine(result.errors[0])}` : ''}`);
        } else {
          log.debug(`${batch}: done in ${seconds(startedAt)} — ${received.size}/${filePaths.length} file(s) reported`);
        }
      }
    } catch (err) {
      log.error(`${batch}: Vitest run failed`, err);
    } finally {
      if (timer) { clearTimeout(timer); }
      this._running.delete(runner);
    }

    const stopped = generation !== this._generation;
    const missing = stopped ? [] : filePaths.filter((fp) => owns(fp) && !received.has(fp));
    release();
    return { missing };
  }
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? '';
}
