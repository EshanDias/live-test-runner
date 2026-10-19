/**
 * SessionTraceRunner — runs a batch of test files under light-trace
 * instrumentation and streams per-file results back to the caller.
 *
 * A single Jest process handles all files in the batch:
 *   - liveReporter.js appends one JSON record per completed file to
 *     LTR_REPORTER_FILE. The parent polls that file and fires onFileDone
 *     as each record arrives, giving the UI progressive updates.
 *   - sessionTraceTransform.js instruments source files; sessionTraceRuntime.js
 *     flushes compact hit records to SESSION_TRACE_FILE. After Jest exits the
 *     parent parses that file and updates ExecutionTraceStore.
 *
 * One pass does both jobs — no second "trace" phase is needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Executor, BinaryResolver, FileRunResult, TestCaseRunResult, tail } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { CoverageStore } from '../coverage/CoverageStore';
import { calculate as calcCoverage } from '../coverage/CoverageReport';
import { Manifest, FileCov, LiveCov } from '../coverage/types';
import { logger } from '../utils/logger';

const log = logger.scope('Runner');
const covLog = logger.scope('Coverage');

const SESSION_TRANSFORM_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'sessionTraceTransform.js',
);

const LIVE_REPORTER_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'liveReporter.js',
);

const COVERAGE_SETUP_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'ltrCoverageSetup.js',
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Light-trace record emitted by sessionTraceRuntime.js */
interface TestHitRecord {
  type: 'T';
  tf: string;
  tn: string;
  fh: { [srcFile: string]: number[] };
}
interface HookHitRecord {
  type: 'H';
  tf: string;
  fh: { [srcFile: string]: number[] };
}
type HitRecord = TestHitRecord | HookHitRecord;

/** Per-file record written by liveReporter.js */
interface ReporterRecord {
  testFilePath: string;
  status: 'passed' | 'failed';
  failureMessage?: string;
  testResults: Array<{
    ancestorTitles: string[];
    title: string;
    fullName: string;
    status: string;
    duration?: number;
    failureMessages: string[];
    location?: { line: number; column?: number };
  }>;
  console: Array<{ message: string; type: string; origin: string }>;
  startTime?: number;
  endTime?: number;
}

function toFileRunResult(rec: ReporterRecord): FileRunResult {
  return {
    testFilePath: rec.testFilePath,
    status: rec.status,
    failureMessage: rec.failureMessage,
    testCases: rec.testResults.map((tc): TestCaseRunResult => ({
      ancestorTitles: tc.ancestorTitles,
      title: tc.title,
      fullName: tc.fullName,
      status: tc.status as TestCaseRunResult['status'],
      duration: tc.duration,
      failureMessages: tc.failureMessages,
      location: tc.location
        ? { line: tc.location.line, column: tc.location.column ?? 0 }
        : undefined,
    })),
    consoleOutput: rec.console.map((c) => ({
      message: c.message,
      type: c.type,
      origin: c.origin,
    })),
    duration:
      rec.startTime != null && rec.endTime != null
        ? rec.endTime - rec.startTime
        : undefined,
  };
}

export class SessionTraceRunner {
  /** Batch counter — "b7" in log lines ties a batch's messages together. */
  private static _batchSeq = 0;
  /** file path → the executor (and its batch id) currently running that file. */
  private readonly _executors = new Map<string, { executor: Executor; batch: string }>();
  private readonly _binaryResolver = new BinaryResolver();
  private _killed = false;

  kill(): void {
    this._killed = true;
    for (const { executor } of this._executors.values()) {
      executor.kill();
    }
    this._executors.clear();
  }

  reset(): void {
    this._killed = false;
  }

  private get _coverageDir()  { return path.join(this._tmpDir, 'coverage'); }
  private get _manifestDir()  { return path.join(this._tmpDir, 'coverage', 'manifests'); }
  /** Stable per-session transform cache — shared across all batches so Jest doesn't re-compile every file each run. */
  private get _transformCacheDir() { return path.join(this._tmpDir, 'ltr-transform-cache'); }

  constructor(
    private readonly _tmpDir: string,
    private readonly _coverageStore: CoverageStore,
  ) {}

  /**
   * Run a batch of test files under combined test+trace instrumentation.
   *
   * - Calls applyFileResult for each file as results arrive (streaming).
   * - Calls onFileDone after each file so the UI status bar stays live.
   * - Updates traceStore with the source→test dependency map after the run.
   * - Returns the list of files that produced no result (crashed mid-batch).
   */
  async runFiles(options: {
    filePaths: string[];
    projectRoot: string;
    traceStore: ExecutionTraceStore;
    store: ResultStore;
    applyFileResult: (filePath: string, fileResult: FileRunResult) => void;
    onFileDone: (filePath: string, status: 'passed' | 'failed') => void;
    log?: (msg: string) => void;
  }): Promise<{ missing: string[] }> {
    const { filePaths, projectRoot, traceStore, store: _store, applyFileResult, onFileDone, log: rawLog } = options;
    if (filePaths.length === 0) { return { missing: [] }; }
    const emit = rawLog ?? (() => {});
    const batch = `b${++SessionTraceRunner._batchSeq}`;
    const startedAt = Date.now();

    fs.mkdirSync(this._tmpDir, { recursive: true });

    const rand = Math.random().toString(36).slice(2);
    const ts   = Date.now();

    const reporterFile    = path.join(this._tmpDir, `ltr-reporter-${ts}-${rand}.jsonl`);
    const traceFile       = path.join(this._tmpDir, `ltr-trace-${ts}-${rand}.jsonl`);
    const covCountersFile = path.join(this._coverageDir, `ltr-cov-${ts}-${rand}.jsonl`);
    const tempConfigPath  = path.join(this._tmpDir, `ltr-cfg-${ts}-${rand}.js`);

    try {
      fs.mkdirSync(this._manifestDir, { recursive: true });
    } catch (err) {
      covLog.error(`Could not create ${this._manifestDir} — coverage will be missing for this run`, err);
    }

    // Normalize to forward slashes: jest normalises all file paths to forward
    // slashes before checking transform patterns, so the regex must match the
    // normalised form regardless of the OS separator.
    // On Windows, the drive letter case is unpredictable — VS Code may give 'c:\'
    // while Jest's path.resolve returns 'C:\'. Use a character class [cC] so the
    // pattern matches regardless of which case Jest uses internally.
    const rootFwd = projectRoot.replace(/\\/g, '/');
    const driveMatch = rootFwd.match(/^([a-zA-Z]):(.*)/);
    const escapedRoot = driveMatch
      ? `[${driveMatch[1].toLowerCase()}${driveMatch[1].toUpperCase()}]:${escapeRegex(driveMatch[2])}`
      : escapeRegex(rootFwd);
    const escapedRootSlash = escapedRoot.replace(/\//g, '[/\\\\]');
    const srcPattern = `^${escapedRootSlash}[/\\\\](?!node_modules[/\\\\]).+\\.[jt]sx?$`;

    const configContent = `
'use strict';
const _path = require('path');
const _fs   = require('fs');
// Temporary Jest config — Live Test Runner combined test+trace run
let baseConfig = {};
let _baseConfigLoaded = false;
try {
  const e = require(${JSON.stringify(path.join(projectRoot, 'jest.config.js'))});
  baseConfig = (e && e.default) ? e.default : e;
  _baseConfigLoaded = true;
} catch (_) {
  try {
    const e = require(${JSON.stringify(path.join(projectRoot, 'jest.config.cjs'))});
    baseConfig = (e && e.default) ? e.default : e;
    _baseConfigLoaded = true;
  } catch (_) {
    try {
      const pkg = require(${JSON.stringify(path.join(projectRoot, 'package.json'))});
      if (pkg.jest) { baseConfig = pkg.jest; }
    } catch (_) {}
  }
}

// CRA fallback: extract the full Jest config from react-scripts if no jest.config was found
// or if testEnvironment is missing (CRA uses jsdom which must be in the extracted config).
if (!_baseConfigLoaded || !baseConfig.testEnvironment) {
  const reactScriptsBin = _path.join(${JSON.stringify(projectRoot)}, 'node_modules', 'react-scripts', 'bin', 'react-scripts.js');
  if (_fs.existsSync(reactScriptsBin)) {
    try {
      const { execFileSync } = require('child_process');
      const stdout = execFileSync(process.execPath, [reactScriptsBin, 'test', '--showConfig', '--passWithNoTests'], {
        cwd: ${JSON.stringify(projectRoot)},
        env: { ...process.env, NODE_ENV: 'test', BABEL_ENV: 'test', CI: 'true' },
        encoding: 'utf8',
        timeout: 30000,
      });
      const jsonStart = stdout.indexOf('{');
      if (jsonStart !== -1) {
        const raw = JSON.parse(stdout.slice(jsonStart));
        const extracted = Array.isArray(raw.configs) ? raw.configs[0] : raw;
        if (extracted) {
          // Strip internal-only keys and merge with any user overrides from package.json
          const skip = new Set(['cwd', 'name', 'id', 'silent']);
          const craConfig = {};
          for (const [k, v] of Object.entries(extracted)) {
            if (!skip.has(k)) { craConfig[k] = v; }
          }
          // Normalize craConfig.moduleNameMapper from Jest's internal array-of-tuples
          // format (from --showConfig) to a plain object so it can be merged.
          let craMapper = craConfig.moduleNameMapper || {};
          if (Array.isArray(craMapper)) {
            craMapper = Object.fromEntries(craMapper.map(([p, v]) => [p, v]));
          }
          const baseMapper = baseConfig.moduleNameMapper || {};
          baseConfig = {
            ...craConfig,
            ...baseConfig,
            moduleNameMapper: { ...craMapper, ...baseMapper },
          };
        }
      }
    } catch (_e) {
      process.stderr.write('[LTR:error] CRA config extraction (react-scripts test --showConfig) failed: ' + String(_e.message).replace(/\\s*\\r?\\n\\s*/g, ' ↵ ') + '\\n');
    }
  }
}

// We pass explicit file paths via --runTestsByPath so Jest doesn't need
// to discover tests. Dropping roots avoids Haste scan failures on Windows.
delete baseConfig.roots;
delete baseConfig.testMatch;
delete baseConfig.testRegex;

const baseTransformObj = Array.isArray(baseConfig.transform)
  ? Object.fromEntries(baseConfig.transform.map(([p, t, o]) => o ? [p, [t, o]] : [p, t]))
  : (baseConfig.transform || {});

const hasGeneralJsTransform = Object.keys(baseTransformObj).some(pattern => {
  try { return new RegExp(pattern).test('src/foo.js'); } catch(_) { return false; }
});

let fallbackTransform = {};
if (!hasGeneralJsTransform) {
  const babelJestPath = require.resolve('babel-jest', { paths: [${JSON.stringify(projectRoot)}, __dirname] });
  let presets;
  try {
    const reactAppPreset = require.resolve('babel-preset-react-app', { paths: [${JSON.stringify(projectRoot)}] });
    presets = [[reactAppPreset, { runtime: 'automatic' }]];
  } catch(_) {
    try {
      const presetEnv = require.resolve('@babel/preset-env', { paths: [${JSON.stringify(projectRoot)}] });
      presets = [[presetEnv, { targets: { node: 'current' } }]];
    } catch(_) { presets = []; }
  }
  if (presets.length > 0) {
    fallbackTransform = { ['^.+\\\\.[jt]sx?$']: [babelJestPath, { configFile: false, presets }] };
  }
}


module.exports = {
  ...baseConfig,
  rootDir: ${JSON.stringify(projectRoot)},
  roots: [${JSON.stringify(projectRoot)}],
  // Raise test timeout to account for the instrumentation overhead added by
  // sessionTraceTransform (step() calls before every statement slow React renders).
  // Tests that approach the default 5 s limit will timeout under instrumentation.
  testTimeout: Math.max((baseConfig.testTimeout || 5000), 30000),
  transform: {
    [${JSON.stringify(srcPattern)}]: ${JSON.stringify(SESSION_TRANSFORM_PATH)},
    ...baseTransformObj,
    ...fallbackTransform,
  },
  setupFilesAfterEnv: [
    ...((baseConfig.setupFilesAfterEnv || [])),
    ${JSON.stringify(COVERAGE_SETUP_PATH)},
  ],
  reporters: [
    'default',
    [${JSON.stringify(LIVE_REPORTER_PATH)}, { outputFile: ${JSON.stringify(reporterFile)} }],
  ],
};
`;

    fs.writeFileSync(tempConfigPath, configContent, 'utf8');

    // Track which files received reporter results for missing-file detection.
    const received = new Set<string>();
    /** File Jest is executing right now (from liveReporter "start" records). */
    let current: { file: string; at: number } | undefined;

    const onRecord = (raw: unknown) => {
      const ev = raw as { ltrEvent?: string; testFilePath?: string; at?: number };
      if (ev?.ltrEvent === 'start') {
        if (ev.testFilePath) {
          current = { file: path.normalize(ev.testFilePath), at: ev.at ?? Date.now() };
          log.trace(`${batch}: started ${path.basename(current.file)}`);
        }
        return;
      }
      const rec = raw as ReporterRecord;
      if (!rec || !rec.testFilePath) { return; }
      rec.testFilePath = path.normalize(rec.testFilePath);
      received.add(rec.testFilePath);
      if (rec.failureMessage) {
        // The file itself failed to run (syntax error, missing module, setup
        // crash, or an instrumentation problem) — no test inside it executed.
        const firstLine = rec.failureMessage.split('\n').find((l) => l.trim()) ?? '';
        log.warn(`${batch}: ${path.basename(rec.testFilePath)} failed to run — ${firstLine.trim()}`);
      }
      try {
        const fileResult = toFileRunResult(rec);
        applyFileResult(rec.testFilePath, fileResult);
        onFileDone(rec.testFilePath, rec.status);
      } catch (err) {
        log.error(`${batch}: could not apply results for ${rec.testFilePath}`, err);
      }
    };

    if (this._killed) { return { missing: filePaths }; }

    // Watchdog: a batch with no finished file for a long time is either slow
    // or hung. Say which file it is on so the two can be told apart.
    let lastProgressAt = Date.now();
    let lastReceived = 0;
    let nextWarnAt = Date.now() + SLOW_BATCH_WARN_MS;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (received.size !== lastReceived) {
        lastReceived = received.size;
        lastProgressAt = now;
        nextWarnAt = Math.max(nextWarnAt, now + SLOW_BATCH_WARN_MS);
        return;
      }
      if (now < nextWarnAt) { return; }
      nextWarnAt = now + SLOW_BATCH_WARN_MS * 2;
      const onFile = current && !received.has(current.file)
        ? `currently on ${path.basename(current.file)} (${Math.round((now - current.at) / 1000)}s in that file)`
        : current
          ? 'between files'
          : 'no test file has started yet (Jest is still starting up / loading config)';
      log.warn(
        `${batch}: no file has finished in ${Math.round((now - lastProgressAt) / 1000)}s — ` +
        `${received.size}/${filePaths.length} done, ${onFile}. ` +
        'Slow tests keep making progress; if this repeats for the same file, a test there is probably hanging (never-resolving promise, infinite loop, open handle).',
      );
    }, 5_000);

    try {
      let binary: string;
      try {
        binary = this._resolveBinary(projectRoot);
      } catch (err) {
        log.error(`Could not find a Jest binary for ${projectRoot}`, err);
        throw err;
      }

      log.debug(`${batch}: running ${filePaths.length} file(s) — ${filePaths.map((p) => path.basename(p)).join(', ')}`);

      // Cancel any in-flight executor already running these files, then create a
      // fresh one registered under each file path so kill() can reach it.
      const executor = new Executor();
      const cancelled = new Set<string>();
      for (const fp of filePaths) {
        const prev = this._executors.get(fp);
        if (prev && !cancelled.has(prev.batch)) {
          cancelled.add(prev.batch);
          // The whole previous batch dies, not just this file — its unfinished
          // files come back as "missing" and are retried (slower) by SessionManager.
          log.info(
            `${batch}: ${path.basename(fp)} was still running in ${prev.batch} — cancelling ${prev.batch}; ` +
            'its unfinished files will be retried',
          );
          prev.executor.kill();
        }
        this._executors.set(fp, { executor, batch });
      }

      executor.setLogger(emit);

      const result = await executor.runWithReporterPolling(
        {
          binary,
          args: [
            '--watchAll=false',
            '--forceExit',
            '--no-bail',
            '--runTestsByPath',
            ...filePaths.map((p) => p.replace(/\\/g, '/')),
            '--config', tempConfigPath,
            '--cacheDirectory', this._transformCacheDir,
            '--maxWorkers=1',
            '--testLocationInResults',
            // Jest silently switches to verbose mode when exactly one test file
            // runs (and honours `verbose: true` from the project config). In
            // verbose mode console output is printed straight to the terminal
            // and testResult.console is empty, so the Results panel showed no
            // logs for single-file reruns. Forcing it off keeps console buffered.
            '--verbose=false',
          ],
          cwd: projectRoot,
          extraEnv: {
            SESSION_TRACE_FILE:   traceFile,
            COVERAGE_OUTPUT_FILE: covCountersFile,
            LTR_MANIFEST_DIR:     this._manifestDir,
            LTR_LOG_LEVEL:        logger.level,
          },
        },
        reporterFile,
        onRecord,
      );

      if (this._killed) {
        log.debug(`${batch}: stopped by the user after ${secondsSince(startedAt)}`);
      } else if (received.size === 0) {
        // Whole batch produced nothing — Jest itself failed (config, transform,
        // environment). SessionManager falls back to plain Jest next; this line
        // records WHY so the fallback isn't a mystery.
        log.warn(
          `${batch}: instrumented Jest run returned no results for ${filePaths.length} file(s). Jest said:\n` +
          tail(result.stderr + '\n' + result.stdout),
        );
      } else {
        log.debug(`${batch}: done in ${secondsSince(startedAt)} — ${received.size}/${filePaths.length} file(s) reported`);
      }
    } catch (err) {
      log.error(`${batch}: Jest run failed`, err);
    } finally {
      clearInterval(watchdog);
      for (const fp of filePaths) {
        // Only remove our own registration — a newer batch may own this file now.
        if (this._executors.get(fp)?.batch === batch) { this._executors.delete(fp); }
      }
      try { fs.unlinkSync(tempConfigPath); } catch {}
    }

    // Parse trace hits and update ExecutionTraceStore.
    try {
      this._parseTrace(traceFile, traceStore, batch);
    } catch (err) {
      log.error(`${batch}: could not parse the trace file`, err);
    } finally {
      try { fs.unlinkSync(traceFile); } catch {}
      try { fs.unlinkSync(reporterFile); } catch {}
    }

    // Parse coverage counters and promote CoverageStore entries.
    try {
      this._parseCoverage(covCountersFile, projectRoot, batch);
    } catch (err) {
      covLog.error(`${batch}: could not parse coverage counters`, err);
    }

    const missing = filePaths.filter((fp) => !received.has(fp));
    return { missing };
  }

  // ── Private: binary resolution ────────────────────────────────────────────

  /**
   * Resolve the Jest binary for this project.
   *
   * For CRA projects, react-scripts bundles its own jest version internally.
   * The config we generate for these projects (via react-scripts --showConfig)
   * contains absolute paths to modules inside react-scripts' node_modules — all
   * designed for that bundled jest version. Running those configs with the
   * project-level jest (which may be a different major version) causes module
   * API incompatibilities (e.g. jest-circus, babel-jest). We therefore prefer
   * CRA's bundled binary when it exists, exactly like CRAAdapter.resolveBinary().
   */
  private _resolveBinary(projectRoot: string): string {
    const craJest = path.join(
      projectRoot, 'node_modules', 'react-scripts', 'node_modules', '.bin', 'jest',
    );
    if (fs.existsSync(craJest + '.cmd')) { return `${craJest}.cmd`; }
    if (fs.existsSync(craJest))          { return craJest; }
    return this._binaryResolver.resolve(projectRoot);
  }

  // ── Private: parse light-trace JSONL and update ExecutionTraceStore ──────────

  private _parseCoverage(covCountersFile: string, projectRoot: string, batch: string): void {
    if (!fs.existsSync(covCountersFile)) {
      // Normal when the batch imported no instrumented source files (or was killed).
      covLog.debug(`${batch}: no coverage counters written`);
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(covCountersFile, 'utf8');
    } catch (err) {
      covLog.error(`${batch}: could not read ${covCountersFile}`, err);
      return;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    // Merge all workers: sum within this run
    const mergedCov: Record<string, FileCov> = {};
    let parseErrors = 0;
    for (const line of lines) {
      let parsed: { workerPid: number; cov: Record<string, FileCov> };
      try { parsed = JSON.parse(line); } catch { parseErrors++; continue; }
      for (const [hash, fileCov] of Object.entries(parsed.cov)) {
        if (!mergedCov[hash]) {
          mergedCov[hash] = { s: { ...fileCov.s }, b: {}, f: { ...fileCov.f } };
          for (const [id, arms] of Object.entries(fileCov.b)) {
            mergedCov[hash].b[id] = [...(arms as number[])];
          }
        } else {
          for (const [id, val] of Object.entries(fileCov.s)) {
            mergedCov[hash].s[id] = (mergedCov[hash].s[id] ?? 0) + val;
          }
          for (const [id, arms] of Object.entries(fileCov.b)) {
            mergedCov[hash].b[id] = (arms as number[]).map(
              (v, i) => (mergedCov[hash].b[id]?.[i] ?? 0) + v,
            );
          }
          for (const [id, val] of Object.entries(fileCov.f)) {
            mergedCov[hash].f[id] = (mergedCov[hash].f[id] ?? 0) + val;
          }
        }
      }
    }

    if (parseErrors > 0) {
      covLog.warn(`${batch}: ${parseErrors} coverage record(s) were corrupt and skipped (a Jest worker may have been killed mid-write)`);
    }

    // Promote CoverageStore entries — max() merge with existing for cross-run accumulation
    let promoted = 0;
    let excluded = 0;
    const missingManifests: string[] = [];
    let manifestReadErrors = 0;

    for (const [fileHash, counters] of Object.entries(mergedCov)) {
      const manifestPath = path.join(this._manifestDir, `${fileHash}.json`);
      if (!fs.existsSync(manifestPath)) {
        missingManifests.push(fileHash);
        continue;
      }

      let manifest: Manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch (err) {
        manifestReadErrors++;
        covLog.debug(`${batch}: unreadable manifest ${manifestPath} — ${(err as Error).message}`);
        continue;
      }

      const normalizedFilePath = manifest.filePath.replace(/^[A-Z]:/, m => m.toLowerCase());
      const relPath = path.relative(projectRoot, normalizedFilePath);
      if (_isExcludedFromCoverage(relPath)) {
        excluded++;
        continue;
      }

      const existing = this._coverageStore.getEntry(normalizedFilePath);
      const merged: LiveCov =
        existing?.state === 'measured'
          ? _mergeCounters(existing.counters, counters)
          : counters;

      const pct = calcCoverage(manifest, merged);
      this._coverageStore.setMeasuredEntry(normalizedFilePath, { manifestPath, counters: merged, pct });
      promoted++;
    }

    covLog.debug(
      `${batch}: ${promoted} file(s) measured, ${excluded} excluded (from ${lines.length} worker record(s))`,
    );
    if (missingManifests.length > 0 || manifestReadErrors > 0) {
      // Counters without a manifest cannot be mapped to lines — those files show no coverage.
      covLog.warn(
        `${batch}: coverage dropped for ${missingManifests.length + manifestReadErrors} file(s) — ` +
        `${missingManifests.length} manifest(s) missing, ${manifestReadErrors} unreadable (folder: ${this._manifestDir})`,
      );
    }

    try {
      fs.unlinkSync(covCountersFile);
    } catch (err) {
      covLog.debug(`${batch}: could not delete ${covCountersFile} — ${(err as Error).message}`);
    }
  }

  // ── Private: parse light-trace JSONL and update ExecutionTraceStore ──────────

  private _parseTrace(
    traceFile: string,
    traceStore: ExecutionTraceStore,
    batch: string,
  ): void {
    if (!fs.existsSync(traceFile)) {
      log.trace(`${batch}: no trace file written`);
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(traceFile, 'utf8');
    } catch (err) {
      log.error(`${batch}: could not read trace file ${traceFile}`, err);
      return;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    const testsByFile  = new Map<string, TestHitRecord[]>();
    const hooksByFile  = new Map<string, HookHitRecord[]>();

    for (const line of lines) {
      let rec: HitRecord;
      try { rec = JSON.parse(line) as HitRecord; } catch { continue; }
      if (!rec || !rec.tf) { continue; }
      if (rec.type === 'T') {
        const bucket = testsByFile.get(rec.tf) ?? [];
        bucket.push(rec);
        testsByFile.set(rec.tf, bucket);
      } else if (rec.type === 'H') {
        const bucket = hooksByFile.get(rec.tf) ?? [];
        bucket.push(rec);
        hooksByFile.set(rec.tf, bucket);
      }
    }

    // Coverage index — aggregate all hit lines across every test + hook.
    for (const recs of testsByFile.values()) {
      for (const rec of recs) {
        for (const [srcFile, linesArr] of Object.entries(rec.fh)) {
          traceStore.addCoveredLines(_normPath(srcFile), linesArr);
        }
      }
    }
    for (const recs of hooksByFile.values()) {
      for (const rec of recs) {
        for (const [srcFile, linesArr] of Object.entries(rec.fh)) {
          traceStore.addCoveredLines(_normPath(srcFile), linesArr);
        }
      }
    }

    // Line → test reverse index — for each test, record which lines it hit in each source file.
    for (const [testFilePath, testRecs] of testsByFile) {
      // Accumulate: sourceFile → line → Set<fullName>
      const fileLineMap = new Map<string, Map<number, string[]>>();
      for (const rec of testRecs) {
        for (const [srcFile, linesArr] of Object.entries(rec.fh)) {
          if (_normPath(srcFile) === testFilePath) { continue; }
          const normSrc = _normPath(srcFile);
          let lineMap = fileLineMap.get(normSrc);
          if (!lineMap) {
            lineMap = new Map();
            fileLineMap.set(normSrc, lineMap);
          }
          for (const line of linesArr) {
            const names = lineMap.get(line) ?? [];
            if (!names.includes(rec.tn)) { names.push(rec.tn); }
            lineMap.set(line, names);
          }
        }
      }
      for (const [srcFile, lineMap] of fileLineMap) {
        traceStore.mergeLineToTests(srcFile, testFilePath, lineMap);
      }
    }

    // sourceToTests index — for each test file, map source files to the tests that hit them.
    for (const [testFilePath, testRecs] of testsByFile) {
      const testNames = testRecs.map((r) => r.tn);

      const hookFiles = new Set<string>();
      for (const hookRec of hooksByFile.get(testFilePath) ?? []) {
        for (const srcFile of Object.keys(hookRec.fh)) {
          if (_normPath(srcFile) !== testFilePath) { hookFiles.add(_normPath(srcFile)); }
        }
      }

      const perTestFiles = new Map<string, string[]>();
      for (const rec of testRecs) {
        const files: string[] = [];
        for (const srcFile of Object.keys(rec.fh)) {
          if (_normPath(srcFile) !== testFilePath) { files.push(_normPath(srcFile)); }
        }
        perTestFiles.set(rec.tn, files);
      }

      const touchedSourceFiles = new Set<string>(hookFiles);
      for (const files of perTestFiles.values()) {
        for (const f of files) { touchedSourceFiles.add(f); }
      }

      for (const sourceFile of touchedSourceFiles) {
        const touchingTests: string[] = [];
        for (const tn of testNames) {
          const files = perTestFiles.get(tn) ?? [];
          if (files.includes(sourceFile) || hookFiles.has(sourceFile)) {
            touchingTests.push(tn);
          }
        }

        const sourceMap: {
          [suite: string]: { isSharedVars: boolean; sharedVarNames: string[]; testCases: string[] };
        } = {};
        for (const tn of touchingTests) {
          const suiteName = _extractSuiteName(tn);
          if (!sourceMap[suiteName]) {
            sourceMap[suiteName] = { isSharedVars: false, sharedVarNames: [], testCases: [] };
          }
          if (!sourceMap[suiteName].testCases.includes(tn)) {
            sourceMap[suiteName].testCases.push(tn);
          }
        }

        const existing = traceStore.getSourceMapping(sourceFile) ?? {};
        const existingForFile = existing[testFilePath] ?? {};
        const mergedForFile = { ...existingForFile };
        for (const [suiteName, suiteInfo] of Object.entries(sourceMap)) {
          if (mergedForFile[suiteName]) {
            const existingCases = mergedForFile[suiteName].testCases;
            const newCases = suiteInfo.testCases.filter((t) => !existingCases.includes(t));
            mergedForFile[suiteName] = {
              ...mergedForFile[suiteName],
              testCases: [...existingCases, ...newCases],
            };
          } else {
            mergedForFile[suiteName] = suiteInfo;
          }
        }

        traceStore.setSourceMapping(sourceFile, {
          ...existing,
          [testFilePath]: mergedForFile,
        });
      }
    }

    const totalTests = Array.from(testsByFile.values()).reduce((n, recs) => n + recs.length, 0);
    log.debug(`${batch}: traced ${totalTests} test(s) across ${testsByFile.size} file(s)`);
  }
}

function _mergeCounters(a: LiveCov, b: FileCov): LiveCov {
  return {
    s: Object.fromEntries(
      Object.keys({ ...a.s, ...b.s }).map((id) => [id, Math.max(a.s[id] ?? 0, b.s[id] ?? 0)]),
    ),
    b: Object.fromEntries(
      Object.keys({ ...a.b, ...b.b }).map((id) => [
        id,
        (a.b[id] ?? []).map((v, i) => Math.max(v, (b.b[id] as number[] | undefined)?.[i] ?? 0)),
      ]),
    ),
    f: Object.fromEntries(
      Object.keys({ ...a.f, ...b.f }).map((id) => [id, Math.max(a.f[id] ?? 0, b.f[id] ?? 0)]),
    ),
  };
}

/** A batch with no finished file for this long gets a "still running" warning. */
const SLOW_BATCH_WARN_MS = 60_000;

function secondsSince(t: number): string {
  return `${((Date.now() - t) / 1000).toFixed(1)}s`;
}

function _extractSuiteName(fullTestName: string): string {
  const lastSep = fullTestName.lastIndexOf(' > ');
  return lastSep !== -1 ? fullTestName.slice(0, lastSep) : fullTestName;
}

const _COVERAGE_EXCLUDE_RE = [
  /[/\\]node_modules[/\\]/,
  /\.(test|spec)\.(js|ts|jsx|tsx)$/,
  /[/\\](__tests__|__mocks__|tests?|specs?)[/\\]/,
  /\.config\.(js|ts|mjs|cjs)$/,
  /\.d\.ts$/,
  /[/\\](dist|build|out|\.next|coverage)[/\\]/,
];

function _isExcludedFromCoverage(filePath: string): boolean {
  return _COVERAGE_EXCLUDE_RE.some((re) => re.test(filePath));
}

function _normPath(filePath: string): string {
  return filePath.replace(/^[A-Z]:/, m => m.toLowerCase());
}
