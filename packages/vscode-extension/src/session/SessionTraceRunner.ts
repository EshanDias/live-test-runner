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
import { Executor, BinaryResolver, FileRunResult, TestCaseRunResult } from '@live-test-runner/runner';
import { ResultStore } from '../store/ResultStore';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { CoverageStore } from '../coverage/CoverageStore';
import { calculate as calcCoverage } from '../coverage/CoverageReport';
import { Manifest, FileCov, LiveCov } from '../coverage/types';
import { logger } from '../utils/logger';

const FILE = 'SessionTraceRunner.ts';

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
  private readonly _executors = new Map<string, Executor>();
  private readonly _binaryResolver = new BinaryResolver();
  private _killed = false;

  kill(): void {
    this._killed = true;
    for (const executor of this._executors.values()) {
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
    const { filePaths, projectRoot, traceStore, store: _store, applyFileResult, onFileDone, log } = options;
    if (filePaths.length === 0) { return { missing: [] }; }
    const emit = log ?? (() => {});

    fs.mkdirSync(this._tmpDir, { recursive: true });

    const rand = Math.random().toString(36).slice(2);
    const ts   = Date.now();

    const reporterFile    = path.join(this._tmpDir, `ltr-reporter-${ts}-${rand}.jsonl`);
    const traceFile       = path.join(this._tmpDir, `ltr-trace-${ts}-${rand}.jsonl`);
    const covCountersFile = path.join(this._coverageDir, `ltr-cov-${ts}-${rand}.jsonl`);
    const tempConfigPath  = path.join(this._tmpDir, `ltr-cfg-${ts}-${rand}.js`);

    logger.info(FILE, 'runFiles', `[Coverage] Preparing coverage dirs — manifestDir="${this._manifestDir}" coverageDir="${this._coverageDir}"`);
    try {
      fs.mkdirSync(this._manifestDir, { recursive: true });
      logger.info(FILE, 'runFiles', `[Coverage] manifestDir ready: "${this._manifestDir}"`);
    } catch (err) {
      logger.error(FILE, 'runFiles', `[Coverage] Failed to create manifestDir "${this._manifestDir}"`, err);
    }
    logger.info(FILE, 'runFiles', `[Coverage] Coverage counters file will be: "${covCountersFile}"`);
    logger.info(FILE, 'runFiles', `[Coverage] Trace file will be: "${traceFile}"`);

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
      process.stderr.write('[LTR] CRA config extraction failed: ' + _e.message + '\\n');
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

    const onRecord = (raw: unknown) => {
      const rec = raw as ReporterRecord;
      if (!rec || !rec.testFilePath) { return; }
      rec.testFilePath = path.normalize(rec.testFilePath);
      received.add(rec.testFilePath);
      try {
        const fileResult = toFileRunResult(rec);
        applyFileResult(rec.testFilePath, fileResult);
        onFileDone(rec.testFilePath, rec.status);
      } catch (err) {
        logger.error(FILE, 'runFiles', `Failed to apply result for "${rec.testFilePath}"`, err);
      }
    };

    if (this._killed) { return { missing: filePaths }; }

    try {
      let binary: string;
      try {
        binary = this._resolveBinary(projectRoot);
      } catch (err) {
        logger.error(FILE, 'runFiles', `Failed to resolve Jest binary for "${projectRoot}"`, err);
        throw err;
      }

      const relNames = filePaths
        .map((p) => path.relative(projectRoot, p))
        .join(', ');
      emit(`[SessionTrace] Running batch (${filePaths.length}): ${relNames}`);

      // Cancel any in-flight executor already running these files, then create a
      // fresh one registered under each file path so kill() can reach it.
      const executor = new Executor();
      for (const fp of filePaths) {
        this._executors.get(fp)?.kill();
        this._executors.set(fp, executor);
      }

      executor.setLogger(emit);
      logger.info(FILE, 'runFiles', `[Coverage] Launching Jest batch — binary="${binary}" files=${filePaths.length} covCountersFile="${covCountersFile}" traceFile="${traceFile}"`);

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
          ],
          cwd: projectRoot,
          extraEnv: {
            SESSION_TRACE_FILE:   traceFile,
            COVERAGE_OUTPUT_FILE: covCountersFile,
            LTR_MANIFEST_DIR:     this._manifestDir,
          },
        },
        reporterFile,
        onRecord,
      );

      logger.info(FILE, 'runFiles', `[Coverage] Jest batch finished — passed=${result.passed} stderrBytes=${result.stderr?.length ?? 0} receivedFiles=${received.size}/${filePaths.length}`);
      if (received.size === 0 && result.stdout) {
        logger.warn(FILE, 'runFiles', `[Coverage] Jest produced 0 results — stdout:\n${result.stdout}`);
      }

      // Diagnostic: check coverage file state immediately after Jest exits
      const covExists = fs.existsSync(covCountersFile);
      if (covExists) {
        try {
          const covSize = fs.statSync(covCountersFile).size;
          logger.info(FILE, 'runFiles', `[Coverage] covCountersFile exists after Jest exit — size=${covSize} bytes path="${covCountersFile}"`);
        } catch (statErr) {
          logger.warn(FILE, 'runFiles', `[Coverage] covCountersFile exists but stat failed`, statErr);
        }
      } else {
        logger.warn(FILE, 'runFiles', `[Coverage] covCountersFile NOT found after Jest exit — path="${covCountersFile}"`);
        // Check if stderr has coverage hints
        if (result.stderr) {
          const covLines = result.stderr.split('\n').filter((l: string) => l.includes('[LTR][Coverage]'));
          if (covLines.length > 0) {
            logger.info(FILE, 'runFiles', `[Coverage] Coverage-related stderr lines:\n${covLines.join('\n')}`);
          } else {
            logger.warn(FILE, 'runFiles', `[Coverage] No [LTR][Coverage] lines in stderr — instrumentation may not have loaded`);
          }
        }
      }

      // Log coverage-related stderr lines regardless
      if (result.stderr) {
        const covLines = result.stderr.split('\n').filter((l: string) => l.includes('[LTR][Coverage]'));
        if (covLines.length > 0) {
          logger.info(FILE, 'runFiles', `[Coverage] Jest stderr coverage lines (${covLines.length}):\n${covLines.slice(0, 20).join('\n')}`);
        }
      }
    } catch (err) {
      logger.error(FILE, 'runFiles', `Jest batch run threw`, err);
      emit(`[SessionTrace] Jest run error: ${(err as Error).message}`);
    } finally {
      for (const fp of filePaths) {
        this._executors.delete(fp);
      }
      try { fs.unlinkSync(tempConfigPath); } catch {}
    }

    // Parse trace hits and update ExecutionTraceStore.
    try {
      this._parseTrace(traceFile, traceStore, emit);
    } catch (err) {
      logger.error(FILE, 'runFiles', `_parseTrace failed`, err);
    } finally {
      try { fs.unlinkSync(traceFile); } catch {}
      try { fs.unlinkSync(reporterFile); } catch {}
    }

    // Parse coverage counters and promote CoverageStore entries.
    try {
      this._parseCoverage(covCountersFile, projectRoot, emit);
    } catch (err) {
      logger.error(FILE, 'runFiles', `_parseCoverage failed`, err);
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

  private _parseCoverage(covCountersFile: string, projectRoot: string, emit: (msg: string) => void): void {
    logger.info(FILE, '_parseCoverage', `[Coverage] Starting coverage parse — file="${covCountersFile}"`);

    if (!fs.existsSync(covCountersFile)) {
      logger.warn(FILE, '_parseCoverage', `[Coverage] Coverage counters file does not exist — no coverage data for this run. file="${covCountersFile}"`);
      emit(`[Coverage] No coverage counters file produced (instrumentation may not have run)`);
      return;
    }

    logger.info(FILE, '_parseCoverage', `[Coverage] Coverage counters file exists: "${covCountersFile}"`);

    let raw: string;
    try {
      raw = fs.readFileSync(covCountersFile, 'utf8');
      logger.info(FILE, '_parseCoverage', `[Coverage] Read coverage counters file: ${raw.length} bytes`);
    } catch (err) {
      logger.error(FILE, '_parseCoverage', `[Coverage] Could not read coverage file: "${covCountersFile}"`, err);
      return;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    logger.info(FILE, '_parseCoverage', `[Coverage] Coverage counters file has ${lines.length} worker record(s)`);

    // Merge all workers: sum within this run
    const mergedCov: Record<string, FileCov> = {};
    let parseErrors = 0;
    for (const line of lines) {
      let parsed: { workerPid: number; cov: Record<string, FileCov> };
      try { parsed = JSON.parse(line); } catch { parseErrors++; continue; }
      const workerHashes = Object.keys(parsed.cov).length;
      logger.debug(FILE, '_parseCoverage', `[Coverage] Merging worker pid=${parsed.workerPid} — ${workerHashes} file-hash(es)`);
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
      logger.warn(FILE, '_parseCoverage', `[Coverage] ${parseErrors} worker record(s) failed to parse`);
    }

    const totalHashes = Object.keys(mergedCov).length;
    logger.info(FILE, '_parseCoverage', `[Coverage] Merged ${totalHashes} unique file-hash(es) from ${lines.length} worker record(s)`);
    emit(`[Coverage] Merged ${totalHashes} file-hash(es) from ${lines.length} worker record(s)`);

    // Promote CoverageStore entries — max() merge with existing for cross-run accumulation
    let promoted = 0;
    let missingManifests = 0;
    let excluded = 0;
    let manifestReadErrors = 0;

    logger.info(FILE, '_parseCoverage', `[Coverage] Checking manifests in "${this._manifestDir}"`);

    // List manifest dir contents for diagnostics
    try {
      const manifestFiles = fs.readdirSync(this._manifestDir);
      logger.info(FILE, '_parseCoverage', `[Coverage] manifestDir contains ${manifestFiles.length} file(s)`);
    } catch (err) {
      logger.warn(FILE, '_parseCoverage', `[Coverage] Could not read manifestDir "${this._manifestDir}"`, err);
    }

    for (const [fileHash, counters] of Object.entries(mergedCov)) {
      const manifestPath = path.join(this._manifestDir, `${fileHash}.json`);
      if (!fs.existsSync(manifestPath)) {
        missingManifests++;
        logger.warn(FILE, '_parseCoverage', `[Coverage] Manifest missing for hash ${fileHash} — expected at "${manifestPath}"`);
        emit(`[Coverage] Manifest missing for hash ${fileHash}, skipping`);
        continue;
      }

      let manifest: Manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch (err) {
        manifestReadErrors++;
        logger.error(FILE, '_parseCoverage', `[Coverage] Could not read manifest "${manifestPath}"`, err);
        continue;
      }

      const normalizedFilePath = manifest.filePath.replace(/^[A-Z]:/, m => m.toLowerCase());
      const relPath = path.relative(projectRoot, normalizedFilePath);
      if (_isExcludedFromCoverage(relPath)) {
        excluded++;
        logger.debug(FILE, '_parseCoverage', `[Coverage] Excluded from coverage: "${relPath}"`);
        continue;
      }

      const existing = this._coverageStore.getEntry(normalizedFilePath);
      const merged: LiveCov =
        existing?.state === 'measured'
          ? _mergeCounters(existing.counters, counters)
          : counters;

      const pct = calcCoverage(manifest, merged);
      logger.debug(FILE, '_parseCoverage',
        `[Coverage] Promoting "${relPath}" — stmts=${pct.statements.covered}/${pct.statements.total} ` +
        `branches=${pct.branches.covered}/${pct.branches.total} fns=${pct.functions.covered}/${pct.functions.total} ` +
        `lines=${pct.lines.covered}/${pct.lines.total}`,
      );
      this._coverageStore.setMeasuredEntry(normalizedFilePath, { manifestPath, counters: merged, pct });
      promoted++;
    }

    logger.info(FILE, '_parseCoverage',
      `[Coverage] Done — promoted=${promoted} excluded=${excluded} missingManifests=${missingManifests} manifestReadErrors=${manifestReadErrors}`,
    );
    emit(`[Coverage] Promoted ${promoted} file(s) to measured (excluded=${excluded}, missingManifests=${missingManifests})`);

    try {
      fs.unlinkSync(covCountersFile);
      logger.debug(FILE, '_parseCoverage', `[Coverage] Deleted coverage counters file: "${covCountersFile}"`);
    } catch (err) {
      logger.warn(FILE, '_parseCoverage', `[Coverage] Could not delete coverage counters file "${covCountersFile}"`, err);
    }
  }

  // ── Private: parse light-trace JSONL and update ExecutionTraceStore ──────────

  private _parseTrace(
    traceFile: string,
    traceStore: ExecutionTraceStore,
    emit: (msg: string) => void,
  ): void {
    if (!fs.existsSync(traceFile)) {
      emit('[SessionTrace] No trace output produced');
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(traceFile, 'utf8');
    } catch (err) {
      logger.error(FILE, '_parseTrace', `Could not read trace file: "${traceFile}"`, err);
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
    emit(`[SessionTrace] Traced ${totalTests} test(s) across ${testsByFile.size} file(s)`);
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
