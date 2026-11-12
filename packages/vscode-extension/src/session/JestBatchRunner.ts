/**
 * JestBatchRunner — the Jest {@link IBatchRunner}: runs a batch of test files
 * under light-trace instrumentation and streams per-file results back to the
 * caller.
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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Executor, BinaryResolver, nodeRuntime, FileRunResult, TestCaseRunResult, tail, toJestPathArg, registerProjectRoot, toRunnerPath, fromRunnerPath, mergeFileResults, jestNodeEnv, jestEsmHint } from '@live-test-runner/runner';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { CoverageStore } from '../coverage/CoverageStore';
import { calculate as calcCoverage } from '../coverage/CoverageReport';
import { Manifest, FileCov, LiveCov } from '../coverage/types';
import { combineWithEntry, cloneCounters, sumCounters, zeroCounters } from '../coverage/coverageRules';
import { combineMeasured, IstanbulFileCoverage, measuredFiles as istanbulMeasuredFiles } from '../coverage/istanbulCoverage';
import { MeasuredFile } from '../coverage/CoverageStore';
import { CoverageScope, coverageScopeOf } from '../coverage/coverageScope';
import { logger } from '../utils/logger';
import { IProjectConfig } from './IProjectConfig';
import { ownFilesPattern, sourceTransformPattern, upperDrive } from './JestProjectConfig';
import { COMPILED_EXTENSIONS, NON_SOURCE_EXTENSIONS, SCRIPT_EXTENSIONS } from './sourceFiles';
import { BatchRunOptions, IBatchRunner } from './IBatchRunner';
import { applyTraceRecords, normPath } from './traceRecords';
import { touch, transformCacheDir } from '../cache/Storage';

const log = logger.scope('Runner');
const covLog = logger.scope('Coverage');

const OWN_FILES_PATTERN = ownFilesPattern();

const SESSION_TRANSFORM_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'jest',
  'sessionTraceTransform.js',
);

const LIVE_REPORTER_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'jest',
  'liveReporter.js',
);

/** Counts files no test loads as `jest --coverage` does (a child process, Jest's own generateEmptyCoverage). */
const COUNT_PATH = path.resolve(__dirname, 'instrumentation', 'jest', 'jestCoverageCount.js');

const COVERAGE_SETUP_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'jest',
  'ltrCoverageSetup.js',
);

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

export class JestBatchRunner implements IBatchRunner {
  /** Batch counter — "b7" in log lines ties a batch's messages together. */
  private static _batchSeq = 0;
  /** Every Jest process this runner started that is still running — for kill(). */
  private readonly _running = new Set<Executor>();
  /**
   * file path → the batch whose result counts for it: the newest run of the
   * file. An older batch still running the same file is left alone (killing
   * it would cancel its other files too) and its result for that file ignored.
   */
  private readonly _owner = new Map<string, string>();
  private readonly _binaryResolver = new BinaryResolver();
  private _killed = false;
  /** ES-module load hints already logged this session (jestEsmHint kinds). */
  private readonly _hintsGiven = new Set<string>();
  /** Bumped by kill(): records from batches started before it are dropped. */
  private _generation = 0;
  /** Roots whose batches measured with Jest's own coverage this session. */
  private readonly _jestCoverageRoots = new Set<string>();
  /** Roots whose files no test loads were counted by Jest this session (or are being counted). */
  private readonly _untestedCounted = new Set<string>();

  kill(): void {
    this._killed = true;
    this._generation++;
    for (const executor of this._running) {
      executor.kill();
    }
    this._running.clear();
    this._owner.clear();
  }

  reset(): void {
    this._killed = false;
    this._hintsGiven.clear();
    this._jestCoverageRoots.clear();
    this._untestedCounted.clear();
  }

  private get _coverageDir()  { return path.join(this._tmpDir, 'coverage'); }
  /**
   * Coverage manifests sit next to the persistent transform cache: a cached
   * transform from an earlier session writes no manifest, so they must outlive
   * the session (named by file path + content, see sessionTraceTransform).
   */
  private _manifestDir(projectRoot: string): string { return path.join(this._transformCacheDir(projectRoot), 'ltr-manifests'); }
  /**
   * Transform cache, per project and kept across sessions. It used to live in
   * the session folder, so every Start re-compiled the whole project — minutes
   * per file on a large CRA app. Entries are keyed by the transform's own hash
   * and the config, so a changed extension or config never reuses stale code.
   */
  private _transformCacheDir(projectRoot: string): string {
    const dir = transformCacheDir(projectRoot);
    touch(dir); // in use: kept by the 30-day pruning
    return dir;
  }

  constructor(
    private readonly _tmpDir: string,
    private readonly _coverageStore: CoverageStore,
    private readonly _projectConfig: IProjectConfig,
  ) {}

  /**
   * Run a batch of test files under combined test+trace instrumentation.
   *
   * - Calls applyFileResult for each file as results arrive (streaming).
   * - Calls onFileDone after each file so the UI status bar stays live.
   * - Updates traceStore with the source→test dependency map after the run.
   * - Calls onFileStart when Jest begins executing a file (files queued in
   *   the batch are not running yet).
   * - Calls onFileTimedOut when a file runs longer than hangTimeoutMs; the
   *   batch is then stopped and its unfinished files come back as missing.
   * - Returns the list of files that produced no result (crashed mid-batch).
   *   Result paths are always the caller's own keys (`filePaths` entries).
   */
  async runFiles(options: BatchRunOptions): Promise<{ missing: string[]; retry?: string }> {
    const { filePaths, projectRoot, traceStore, store: _store, applyFileResult, onFileDone, log: rawLog } = options;
    const hangTimeoutMs = options.hangTimeoutMs ?? 0;
    if (filePaths.length === 0) { return { missing: [] }; }
    const emit = rawLog ?? (() => {});
    const batch = `b${++JestBatchRunner._batchSeq}`;
    const startedAt = Date.now();

    fs.mkdirSync(this._tmpDir, { recursive: true });

    const rand = Math.random().toString(36).slice(2);
    const ts   = Date.now();

    const reporterFile    = path.join(this._tmpDir, `ltr-reporter-${ts}-${rand}.jsonl`);
    const traceFile       = path.join(this._tmpDir, `ltr-trace-${ts}-${rand}.jsonl`);
    const covCountersFile = path.join(this._coverageDir, `ltr-cov-${ts}-${rand}.jsonl`);
    const jestCoverageFile = path.join(this._coverageDir, `ltr-jestcov-${ts}-${rand}.jsonl`);

    for (const dir of [this._coverageDir, this._manifestDir(projectRoot)]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        covLog.error(`Could not create ${dir} — coverage will be missing for this run`, err);
      }
    }

    registerProjectRoot(projectRoot);
    const srcPattern = sourceTransformPattern(projectRoot);
    // Compiled sources (.vue, .svelte, …, and whatever else the project's
    // moduleFileExtensions name): the pattern for one extension is this prefix
    // + the extension. Used only when the project transforms that extension itself.
    const compiledPatternPrefix = sourceTransformPattern(projectRoot, '').replace(/\$$/, '');

    // The project's config as Jest resolved it (any format) — see JestProjectConfig.
    const resolvedConfigPath = await this._projectConfig.get(projectRoot);
    const coverageScope = await coverageScopeOf(this._projectConfig, projectRoot);
    // Jest's spelling: the real path (symlinks resolved), upper-case drive.
    const jestRoot = upperDrive(toRunnerPath(projectRoot));

    const configContent = `
'use strict';
const _path = require('path');
const _fs   = require('fs');
// Temporary Jest config — Live Test Runner combined test+trace run
let baseConfig = {};
let _projects = null;
let _baseConfigLoaded = false;
const _resolvedPath = process.env.LTR_JEST_RESOLVED_CONFIG || null;
if (_resolvedPath) {
  // Resolved by Jest itself (jest --showConfig): works for every config format.
  const r = require(_resolvedPath);
  if (r.configs.length === 1) {
    baseConfig = { ...r.global, ...r.configs[0] };
  } else {
    baseConfig = { ...r.global };
    _projects = r.configs;
  }
  _baseConfigLoaded = true;
}
if (!_baseConfigLoaded) try {
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
if (!_resolvedPath && (!_baseConfigLoaded || !baseConfig.testEnvironment)) {
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

// Our transform / setup file on top of one project's config. Test files are
// passed explicitly (--runTestsByPath, already filtered by jest --listTests
// with this config), and Jest still checks them against the test patterns —
// so the project's own pattern stays (dropping both made Jest use its default
// testMatch and skip e.g. *.jest.js). Only one of the two may be set
// (--showConfig can fill in both); ts-jest reads them too.
function _overlay(cfg) {
  const c = { ...cfg };
  const hasRegex = Array.isArray(c.testRegex) ? c.testRegex.length > 0 : !!c.testRegex;
  const hasMatch = Array.isArray(c.testMatch) && c.testMatch.length > 0;
  if (hasRegex) { delete c.testMatch; }
  else if (hasMatch) { delete c.testRegex; }
  else { delete c.testMatch; delete c.testRegex; }

  const baseTransformObj = Array.isArray(c.transform)
    ? Object.fromEntries(c.transform.map(([p, t, o]) => o ? [p, [t, o]] : [p, t]))
    : (c.transform || {});

  // Jest adds babel-jest for JS/TS when a config has no transform — but only
  // when transform is unset, and we always set it. Add the same default.
  const hasGeneralJsTransform = Object.keys(baseTransformObj).some(pattern => {
    try { return new RegExp(pattern).test('src/foo.js'); } catch(_) { return false; }
  });
  // Sources the project compiles itself (vue-jest, svelte-jester, coffee…):
  // our transform first, it calls theirs. Candidates: our list + the
  // project's moduleFileExtensions; never JS / TS (the pattern above) or assets.
  const componentTransform = {};
  const _skip = new Set(${JSON.stringify([...SCRIPT_EXTENSIONS, ...NON_SOURCE_EXTENSIONS])});
  const _candidates = new Set([...${JSON.stringify(COMPILED_EXTENSIONS)}, ...((c.moduleFileExtensions || []).map((e) => String(e).toLowerCase()))]);
  for (const ext of _candidates) {
    if (_skip.has(ext) || !/^[\\w-]+$/.test(ext)) { continue; }
    const handled = Object.keys(baseTransformObj).some((p) => { try { return new RegExp(p).test('src/Comp.' + ext); } catch (_) { return false; } });
    if (handled) { componentTransform[${JSON.stringify(compiledPatternPrefix)} + ext + '$'] = _ours; }
  }
  let fallbackTransform = {};
  if (!hasGeneralJsTransform) {
    try {
      const babelJestPath = require.resolve('babel-jest', { paths: [${JSON.stringify(projectRoot)}, __dirname] });
      fallbackTransform = { ['\\\\.[jt]sx?$']: babelJestPath };
    } catch (_) {
      process.stderr.write('[LTR:warn] babel-jest is not installed — JS/TS files without a transform in the Jest config run untranspiled\\n');
    }
  }

  return {
    ...c,
    transform: {
      [${JSON.stringify(srcPattern)}]: _ours,
      ...componentTransform,
      ...baseTransformObj,
      ...fallbackTransform,
    },
    // Our own files (setup, runtime) are never the project's to transform:
    // its Babel config could add imports (@babel/runtime helpers) that cannot
    // be resolved from the extension's folder.
    transformIgnorePatterns: [
      ...(c.transformIgnorePatterns || ['/node_modules/', '\\\\.pnp\\\\.[^\\\\/]+$']),
      ${JSON.stringify(OWN_FILES_PATTERN)},
    ],
    // Ours first: its beforeEach opens the per-test trace context before the
    // project's own hooks run, so their hits count for the test.
    setupFilesAfterEnv: [
      ${JSON.stringify(COVERAGE_SETUP_PATH)},
      ...((c.setupFilesAfterEnv || [])),
    ],
  };
}

const _upperDrive = (p) => String(p).replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
// Jest's own coverage, with the project's provider ('babel': istanbul, or 'v8'), so the numbers are
// what \`jest --coverage\` reports. The live reporter keeps each test file's; Jest's coverage reporter
// reports nothing (no untested-file pass per batch: collectCoverageFrom empty; the extension applies
// the project's rules and has Jest count the untested files once).
const _covFile = process.env.LTR_JEST_COVERAGE_FILE;
const _provider = baseConfig.coverageProvider === 'v8' ? 'v8' : 'babel';
const _cov = _covFile
  ? { collectCoverage: true, coverageProvider: _provider, collectCoverageFrom: [], coverageReporters: ['none'], coverageThreshold: undefined,
      coverageDirectory: _path.dirname(_covFile) }
  : {};
// Our transform adds only the trace on top of Jest's coverage (and maps its code back to the file).
const _ours = _covFile ? [${JSON.stringify(SESSION_TRANSFORM_PATH)}, { coverage: _provider }] : ${JSON.stringify(SESSION_TRANSFORM_PATH)};
const _shared = {
  ..._cov,
  // Raise test timeout to account for the instrumentation overhead added by
  // sessionTraceTransform (step() calls before every statement slow React renders).
  // Tests that approach the default 5 s limit will timeout under instrumentation.
  testTimeout: Math.max((baseConfig.testTimeout || 5000), 30000),
  reporters: [
    'default',
    ${JSON.stringify(LIVE_REPORTER_PATH)},
  ],
};

module.exports = _projects
  ? {
      ...baseConfig,
      ..._shared,
      rootDir: ${JSON.stringify(jestRoot)},
      projects: _projects.map((p) => ({
        ..._overlay(p),
        roots: (p.roots || [p.rootDir]).map(_upperDrive),
      })),
    }
  : {
      ..._overlay(baseConfig),
      ..._shared,
      // Same drive-letter spelling as the --runTestsByPath arguments (upper case,
      // like Jest's realpath'd rootDir): Jest compares test paths against roots
      // case-sensitively, so c:\\ vs C:\\ made every file "not found". Dropping
      // the project's roots also avoids Haste scan failures on Windows.
      rootDir: ${JSON.stringify(jestRoot)},
      roots: [${JSON.stringify(jestRoot)}],
    };
`;

    const tempConfigPath = writeStableConfig(this._transformCacheDir(projectRoot), configContent);

    // Track which files received reporter results for missing-file detection.
    const received = new Set<string>();
    /** Results applied in this batch — a file run by several Jest projects reports once per project. */
    const applied = new Map<string, FileRunResult>();
    /** File Jest is executing right now (from liveReporter "start" records). */
    let current: { file: string; at: number } | undefined;
    /** The test running right now (setup-file heartbeats) — what the hang limit measures. */
    let currentTest: { name?: string; at: number } | undefined;
    const generation = this._generation;

    // Jest may report a path differently from how we passed it (drive-letter
    // case, separators, symlinks resolved). Map every reported path back to
    // the caller's key so results land on the right store entry.
    const keyByNorm = new Map(filePaths.map((fp) => [pathKey(fp), fp]));
    const toKey = (p: string) => {
      const q = fromRunnerPath(p);
      return keyByNorm.get(pathKey(q)) ?? path.normalize(q);
    };

    for (const fp of filePaths) {
      const prev = this._owner.get(fp);
      if (prev) {
        log.debug(`${batch}: ${path.basename(fp)} is also still running in ${prev} — only this newer run's result will be used`);
      }
      this._owner.set(fp, batch);
    }
    const owns = (fp: string) => this._owner.get(fp) === batch;

    const onRecord = (raw: unknown) => {
      // Stopped: results still flushed by a dying Jest must not reach the tree.
      if (generation !== this._generation) { return; }
      const ev = raw as { ltrEvent?: string; testFilePath?: string; name?: string };
      if (ev?.ltrEvent === 'start') {
        if (ev.testFilePath) {
          // Our clock, not the event's: a test's fake timers set Jest's Date (Sentry: 2017), every test then looked years old.
          current = { file: toKey(ev.testFilePath), at: Date.now() };
          currentTest = undefined;
          log.trace(`${batch}: started ${path.basename(current.file)}`);
          if (owns(current.file)) { options.onFileStart?.(current.file); }
        }
        return;
      }
      if (ev?.ltrEvent === 'test-start') { currentTest = { name: ev.name, at: Date.now() }; return; }
      if (ev?.ltrEvent === 'test-end') { currentTest = undefined; return; }
      const rec = raw as ReporterRecord;
      if (!rec || !rec.testFilePath) { return; }
      rec.testFilePath = toKey(rec.testFilePath);
      received.add(rec.testFilePath);
      if (!owns(rec.testFilePath)) {
        log.debug(`${batch}: ignoring the result for ${path.basename(rec.testFilePath)} — a newer run of it has started`);
        return;
      }
      if (rec.failureMessage) {
        // The file itself failed to run (syntax error, missing module, setup
        // crash, or an instrumentation problem) — no test inside it executed.
        const firstLine = rec.failureMessage.split('\n').find((l) => l.trim()) ?? '';
        log.warn(`${batch}: ${path.basename(rec.testFilePath)} failed to run — ${firstLine.trim()}`);
        const hint = jestEsmHint(rec.failureMessage, projectRoot);
        if (hint && !this._hintsGiven.has(hint.kind)) {
          this._hintsGiven.add(hint.kind);
          log.warn(`${path.basename(rec.testFilePath)} could not be loaded: ${hint.text}`);
        }
      }
      try {
        const prev = applied.get(rec.testFilePath);
        const fileResult = prev ? mergeFileResults(prev, toFileRunResult(rec)) : toFileRunResult(rec);
        applied.set(rec.testFilePath, fileResult);
        applyFileResult(rec.testFilePath, fileResult);
        if (prev) {
          log.debug(`${batch}: merged another Jest project's result for ${path.basename(rec.testFilePath)}`);
          options.onFileUpdated?.(rec.testFilePath, fileResult.status, prev.status);
        } else {
          onFileDone(rec.testFilePath, fileResult.status);
        }
      } catch (err) {
        log.error(`${batch}: could not apply results for ${rec.testFilePath}`, err);
      }
    };

    const release = () => {
      for (const fp of filePaths) { if (owns(fp)) { this._owner.delete(fp); } }
    };
    if (this._killed) { release(); return { missing: [] }; }

    const executor = new Executor();
    /** Set when the watchdog stopped the batch because a file hung. */
    let timedOut: { file: string; seconds: number; test?: string } | undefined;
    /** A file Jest failed on that is gone again. */
    let vanished: string | undefined;

    // Watchdog: a batch with no finished file for a long time is either slow
    // or hung. Say which file it is on so the two can be told apart.
    let lastProgressAt = Date.now();
    let lastReceived = 0;
    let nextWarnAt = Date.now() + SLOW_BATCH_WARN_MS;
    const watchdog = setInterval(() => {
      const now = Date.now();
      // The limit applies to ONE test, not the whole file: loading a big file
      // on a cold transform cache can legitimately take minutes.
      if (hangTimeoutMs > 0 && !timedOut && current && currentTest && !received.has(current.file) && now - currentTest.at > hangTimeoutMs) {
        timedOut = { file: current.file, seconds: Math.round((now - currentTest.at) / 1000), test: currentTest.name };
        log.warn(
          `${batch}: ${path.basename(current.file)} has run for ${timedOut.seconds}s without finishing` +
          `${currentTest.name ? ` (test "${currentTest.name}")` : ''} — stopping it ` +
          '(probably a hanging test: an infinite loop or a promise that never resolves). ' +
          'The rest of the batch is retried. Change the limit with liveTestRunner.hangTimeoutSeconds.',
        );
        executor.kill();
        return;
      }
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

      this._running.add(executor);
      executor.setLogger(emit);

      const result = await executor.runWithReporterPolling(
        {
          binary,
          args: [
            '--watchAll=false',
            '--forceExit',
            '--no-bail',
            '--runTestsByPath',
            ...filePaths.map(toJestPathArg),
            '--config', tempConfigPath,
            '--cacheDirectory', this._transformCacheDir(projectRoot),
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
            // The test script's Node options (e.g. --experimental-vm-modules: Jest's ESM mode).
            ...jestNodeEnv(projectRoot),
            SESSION_TRACE_FILE:   traceFile,
            COVERAGE_OUTPUT_FILE: covCountersFile,
            LTR_JEST_COVERAGE_FILE: jestCoverageFile,
            LTR_MANIFEST_DIR:     this._manifestDir(projectRoot),
            LTR_LOG_LEVEL:        logger.level,
            LTR_REPORTER_FILE:    reporterFile,
            // Read by the generated config: kept out of its text so the text, and so Jest's cache id, stays the same.
            ...(resolvedConfigPath ? { LTR_JEST_RESOLVED_CONFIG: resolvedConfigPath } : {}),
          },
        },
        reporterFile,
        onRecord,
      );

      if (this._killed || generation !== this._generation) {
        log.debug(`${batch}: stopped by the user after ${secondsSince(startedAt)}`);
      } else if (timedOut) {
        log.debug(`${batch}: stopped after ${secondsSince(startedAt)} — ${path.basename(timedOut.file)} hung`);
      } else if (received.size === 0 && (vanished = vanishedFile(result.stderr + '\n' + result.stdout))) {
        // A test of another batch created and deleted a file while this
        // batch's haste map crawled the project: worth one more try.
        log.debug(`${batch}: Jest failed on ${vanished}, which no longer exists (written by a test during the crawl) — retrying the batch once`);
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
      this._running.delete(executor);
    }

    const stopped = generation !== this._generation;
    if (timedOut && !stopped && owns(timedOut.file)) {
      received.add(timedOut.file); // reported as failed below — never retried
      options.onFileTimedOut?.(timedOut.file, timedOut.seconds);
    }
    // Files a newer batch took over are that batch's business, not missing here.
    const missing = stopped ? [] : filePaths.filter((fp) => owns(fp) && !received.has(fp));
    // Coverage replaces only what finished here: not a file killed by the
    // hang limit (it wrote nothing), not one a newer batch took over.
    const measured = new Set([...received].filter((fp) => owns(fp) && fp !== timedOut?.file));
    release();

    // Parse trace hits and update ExecutionTraceStore.
    try {
      this._parseTrace(traceFile, traceStore, batch, toKey, measured);
    } catch (err) {
      log.error(`${batch}: could not parse the trace file`, err);
    } finally {
      try { fs.unlinkSync(traceFile); } catch {}
      try { fs.unlinkSync(reporterFile); } catch {}
    }

    // Parse coverage counters and promote CoverageStore entries.
    try {
      if (fs.existsSync(jestCoverageFile)) {
        try { fs.unlinkSync(covCountersFile); } catch { /* none */ }
        if (generation === this._generation) { this._parseJestCoverage(jestCoverageFile, projectRoot, batch, coverageScope, { startedAt, ran: measured, toKey }); }
      } else {
        this._parseCoverage(covCountersFile, projectRoot, batch, coverageScope, { startedAt, ran: measured, toKey });
      }
    } catch (err) {
      covLog.error(`${batch}: could not parse coverage counters`, err);
    }

    return vanished && missing.length === filePaths.length ? { missing, retry: `${path.basename(vanished)} vanished during Jest's crawl` } : { missing };
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
    if (fs.existsSync(path.join(projectRoot, 'node_modules', 'react-scripts'))) {
      const entry = BinaryResolver.resolveCraJestEntry(projectRoot);
      if (entry) { return entry; }
    }
    return this._binaryResolver.resolve(projectRoot);
  }

  // ── Private: Jest's own coverage → the CoverageStore ────────────────────────

  /**
   * One line per test file (liveReporter.js): Jest's own coverage of it
   * (either provider), converted as Jest converts it. Each test file that
   * finished replaces its contribution (none: it covers nothing now).
   */
  private _parseJestCoverage(
    file: string,
    projectRoot: string,
    batch: string,
    scope: CoverageScope,
    run: { startedAt: number; ran: Set<string>; toKey: (p: string) => string },
  ): void {
    const startedAt = Date.now();
    const manifestDir = path.join(this._coverageDir, 'jest-manifests');
    const byTestFile = new Map<string, Map<string, MeasuredFile>>();
    let bytes: number;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      bytes = raw.length;
      // Maps arrive once per batch (by key), then only hit counts: each becomes a manifest once.
      const maps = new Map<string, Omit<IstanbulFileCoverage, 's' | 'f' | 'b'>>();
      const versions = new Map<string, { filePath: string; manifestPath: string; manifest: Manifest } | null>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) { continue; }
        let doc: { tf: string; files: Record<string, { k: string; s: FileCov['s']; f: FileCov['f']; b: FileCov['b'] }>; maps: Record<string, Omit<IstanbulFileCoverage, 's' | 'f' | 'b'>> };
        try { doc = JSON.parse(line); } catch { continue; }
        for (const [k, m] of Object.entries(doc.maps ?? {})) { maps.set(k, m); }
        const key = run.toKey(doc.tf);
        const into = byTestFile.get(key) ?? new Map<string, MeasuredFile>();
        for (const hits of Object.values(doc.files ?? {})) {
          let version = versions.get(hits.k);
          if (version === undefined) {
            const m = maps.get(hits.k);
            const zero = m ? { ...m, s: {}, f: {}, b: {} } as IstanbulFileCoverage : undefined;
            const [entry] = zero ? [...istanbulMeasuredFiles({ [m!.path]: zero }, manifestDir, projectRoot, (f) => scope.counts(f)).files] : [];
            version = entry ? { filePath: entry[0], manifestPath: entry[1].manifestPath, manifest: entry[1].manifest } : null;
            versions.set(hits.k, version);
          }
          if (!version) { continue; }
          const counters: FileCov = { s: { ...hits.s }, f: { ...hits.f }, b: Object.fromEntries(Object.entries(hits.b ?? {}).map(([id, arms]) => [id, [...arms]])) };
          into.set(version.filePath, combineMeasured(into.get(version.filePath), { manifestPath: version.manifestPath, manifest: version.manifest, counters }));
        }
        byTestFile.set(key, into);
      }
    } finally {
      try { fs.unlinkSync(file); } catch { /* gone */ }
    }
    const first = !this._jestCoverageRoots.has(projectRoot);
    this._jestCoverageRoots.add(projectRoot);
    let sources = 0;
    for (const testFile of run.ran) {
      const files = byTestFile.get(testFile) ?? new Map<string, MeasuredFile>();
      this._coverageStore.replaceContribution(testFile, files, run.startedAt);
      sources += files.size;
    }
    covLog.debug(`${batch}: coverage — ${run.ran.size} test file(s) → ${sources} file measurement(s) (${Math.round(bytes / 1024)} KB, ${Date.now() - startedAt} ms)`);
    if (first) { void this._countUntested(projectRoot); }
  }

  /**
   * Once per session: every source file the coverage settings count, as
   * \`jest --coverage\` counts a file no test loads — what each shows while no
   * test reaches it (Jest's own generateEmptyCoverage, either provider).
   */
  private async _countUntested(projectRoot: string): Promise<void> {
    if (this._untestedCounted.has(projectRoot)) { return; }
    this._untestedCounted.add(projectRoot);
    // The source scan lists them (the project's rules); wait for it, and for the
    // batches to finish: the count is one more process, outside their shared budget.
    const generation = this._generation;
    for (let i = 0; i < 600 && !this._coverageStore.isScanComplete() && !this._killed; i++) { await new Promise((r) => setTimeout(r, 200)); }
    while (this._running.size > 0 && !this._killed && generation === this._generation) { await new Promise((r) => setTimeout(r, 500)); }
    if (this._killed || generation !== this._generation) { this._untestedCounted.delete(projectRoot); return; }
    const under = (fp: string) => { const rel = path.relative(projectRoot, fp); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    const files = [...this._coverageStore.getAllEntries()].map(([fp]) => fp).filter(under);
    if (!(await this._countJest(files, projectRoot))) { this._untestedCounted.delete(projectRoot); }
  }

  /**
   * Source files created or edited during the session that no test loads:
   * counted as \`jest --coverage\` counts them (until then, the source scan's count).
   */
  async countSources(files: string[], projectRoot: string): Promise<void> {
    if (!this._jestCoverageRoots.has(projectRoot)) { return; }
    const wanted = files.filter((fp) => fs.existsSync(fp) && this._coverageStore.contributorsOf(fp).length === 0);
    if (wanted.length > 0) { await this._countJest(wanted, projectRoot); }
  }

  /** @returns whether the files were counted */
  private async _countJest(files: string[], projectRoot: string): Promise<boolean> {
    const generation = this._generation;
    const scope = await coverageScopeOf(this._projectConfig, projectRoot);
    const counted = files.filter((fp) => scope.counts(fp));
    if (counted.length === 0) { return true; }
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = path.join(this._coverageDir, `ltr-count-${stamp}.json`);
    const out = path.join(this._coverageDir, `ltr-count-${stamp}.out.json`);
    const resolvedConfig = await this._projectConfig.get(projectRoot);
    if (!resolvedConfig) { covLog.debug(`No resolved Jest config for ${projectRoot} — files no test loads keep the source scan's count`); return false; }
    try {
      fs.mkdirSync(this._coverageDir, { recursive: true });
      const provider = (JSON.parse(fs.readFileSync(resolvedConfig, 'utf8')) as { global?: { coverageProvider?: string } }).global?.coverageProvider === 'v8' ? 'v8' : 'babel';
      fs.writeFileSync(request, JSON.stringify({
        rootDir: toRunnerPath(projectRoot), files: counted.map((fp) => toRunnerPath(fp)), out, resolvedConfig, provider,
        cacheDirectory: this._transformCacheDir(projectRoot),
      }));
      const node = nodeRuntime();
      const r = await new Executor(() => {}).run({ binary: node.binary, args: [COUNT_PATH, request], cwd: projectRoot, extraEnv: { ...jestNodeEnv(projectRoot), ...node.env }, timeoutMs: 120_000 });
      if (generation !== this._generation) { return false; }
      if (!fs.existsSync(out)) {
        covLog.debug(`Could not have Jest count ${counted.length} file(s) no test loads: ${tail(r.stderr || r.stdout, 3)}`);
        return false;
      }
      const manifestDir = path.join(this._coverageDir, 'jest-manifests');
      const { files: measured } = istanbulMeasuredFiles(JSON.parse(fs.readFileSync(out, 'utf8')), manifestDir, projectRoot, (fp) => scope.counts(fp));
      for (const [fp, mf] of measured) {
        const zero = zeroCounters(mf.counters);
        this._coverageStore.setMeasuredEntry(fp, { manifestPath: mf.manifestPath, counters: zero, pct: calcCoverage(mf.manifest, zero) });
      }
      covLog.debug(`Jest counted ${measured.size} source file(s) no test loads (${projectRoot})`);
      return true;
    } catch (err) {
      covLog.debug(`Could not have Jest count files no test loads: ${(err as Error).message}`);
      return false;
    } finally {
      for (const f of [request, out]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
    }
  }

  // ── Private: coverage counters → the CoverageStore ──────────────────────────

  /**
   * One record per test file (`tf`, see ltrCoverageSetup.js): each test file
   * that finished in the batch (`run.ran`) replaces its coverage contribution
   * — one with results but no record covers no instrumented file now, so its
   * old contribution goes. A test file several Jest projects ran sums its records.
   */
  private _parseCoverage(
    covCountersFile: string,
    projectRoot: string,
    batch: string,
    scope: CoverageScope,
    run: { startedAt: number; ran: Set<string>; toKey: (p: string) => string },
  ): void {
    const startedAt = Date.now();
    let raw = '';
    if (fs.existsSync(covCountersFile)) {
      try {
        raw = fs.readFileSync(covCountersFile, 'utf8');
      } catch (err) {
        covLog.error(`${batch}: could not read ${covCountersFile}`, err);
        return;
      }
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    // Per test file, per instrumented file (hash): summed counters.
    const byTestFile = new Map<string, Record<string, FileCov>>();
    /** Records without a test file (expect.getState() had no testPath): merged the old way. */
    const untagged: Record<string, FileCov> = {};
    let parseErrors = 0;
    for (const line of lines) {
      let parsed: { workerPid: number; tf?: string; cov: Record<string, FileCov> };
      try { parsed = JSON.parse(line); } catch { parseErrors++; continue; }
      const key = parsed.tf ? run.toKey(parsed.tf) : undefined;
      let into = untagged;
      if (key) {
        into = byTestFile.get(key) ?? {};
        byTestFile.set(key, into);
      }
      for (const [hash, fileCov] of Object.entries(parsed.cov)) { into[hash] = into[hash] ? sumCounters(into[hash], fileCov) : cloneCounters(fileCov); }
    }
    if (parseErrors > 0) {
      covLog.warn(`${batch}: ${parseErrors} coverage record(s) were corrupt and skipped (a Jest worker may have been killed mid-write)`);
    }

    // Manifests, read once per batch.
    const manifests = new Map<string, { manifestPath: string; manifest: Manifest; filePath: string } | null>();
    const missingManifests = new Set<string>();
    let manifestReadErrors = 0;
    let excluded = 0;
    const manifestOf = (fileHash: string) => {
      if (manifests.has(fileHash)) { return manifests.get(fileHash) ?? undefined; }
      const manifestPath = path.join(this._manifestDir(projectRoot), `${fileHash}.json`);
      let found: { manifestPath: string; manifest: Manifest; filePath: string } | null = null;
      if (!fs.existsSync(manifestPath)) {
        missingManifests.add(fileHash);
      } else {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
          const filePath = normPath(manifest.filePath);
          if (scope.counts(filePath)) { found = { manifestPath, manifest, filePath }; } else { excluded++; }
        } catch (err) {
          manifestReadErrors++;
          covLog.debug(`${batch}: unreadable manifest ${manifestPath} — ${(err as Error).message}`);
        }
      }
      manifests.set(fileHash, found);
      return found ?? undefined;
    };
    const measuredFiles = (cov: Record<string, FileCov>) => {
      const files = new Map<string, MeasuredFile>();
      for (const [hash, counters] of Object.entries(cov)) {
        const m = manifestOf(hash);
        if (!m) { continue; }
        const prev = files.get(m.filePath);
        // Two versions of one file in one test file's run cannot happen; two Jest projects with different transforms can.
        files.set(m.filePath, prev && prev.manifestPath === m.manifestPath ? { ...prev, counters: sumCounters(prev.counters, counters) } : { manifestPath: m.manifestPath, manifest: m.manifest, counters });
      }
      return files;
    };

    let contributions = 0;
    const sources = new Set<string>();
    for (const testFile of run.ran) {
      const files = measuredFiles(byTestFile.get(testFile) ?? {});
      for (const f of files.keys()) { sources.add(f); }
      this._coverageStore.replaceContribution(testFile, files, run.startedAt);
      contributions++;
    }

    // Untagged records: the per-batch path (merged with what the store has).
    let untaggedFiles = 0;
    for (const [filePath, mf] of measuredFiles(untagged)) {
      const existing = this._coverageStore.getEntry(filePath);
      const merged: LiveCov = existing?.state === 'measured-stale' ? mf.counters : combineWithEntry(existing, mf.manifestPath, mf.manifest, mf.counters);
      this._coverageStore.setMeasuredEntry(filePath, { manifestPath: mf.manifestPath, counters: merged, pct: calcCoverage(mf.manifest, merged) });
      untaggedFiles++;
    }

    covLog.debug(
      `${batch}: ${contributions} test file(s) → ${sources.size} file(s) measured${untaggedFiles ? ` (+${untaggedFiles} without a test file)` : ''}, ${excluded} excluded ` +
      `(from ${lines.length} worker record(s), ${Math.round(raw.length / 1024)} KB, ${Date.now() - startedAt} ms)`,
    );
    if (missingManifests.size > 0 || manifestReadErrors > 0) {
      // Counters without a manifest cannot be mapped to lines — those files show no coverage.
      covLog.warn(
        `${batch}: coverage dropped for ${missingManifests.size + manifestReadErrors} file(s) — ` +
        `${missingManifests.size} manifest(s) missing, ${manifestReadErrors} unreadable (folder: ${this._manifestDir(projectRoot)})`,
      );
    }

    if (raw) {
      try {
        fs.unlinkSync(covCountersFile);
      } catch (err) {
        covLog.debug(`${batch}: could not delete ${covCountersFile} — ${(err as Error).message}`);
      }
    }
  }

  // ── Private: parse light-trace JSONL and update ExecutionTraceStore ──────────

  private _parseTrace(
    traceFile: string,
    traceStore: ExecutionTraceStore,
    batch: string,
    /** Maps Jest's spelling of a test-file path to the store's key. */
    toKey: (p: string) => string,
    /** Test files that finished: their old entries are replaced. */
    ran: Set<string>,
  ): void {
    if (!fs.existsSync(traceFile)) {
      log.trace(`${batch}: no trace file written`);
      return;
    }

    const startedAt = Date.now();
    let raw: string;
    try {
      raw = fs.readFileSync(traceFile, 'utf8');
    } catch (err) {
      log.error(`${batch}: could not read trace file ${traceFile}`, err);
      return;
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const summary = applyTraceRecords(lines, traceStore, toKey, ran);
    log.debug(`${batch}: traced ${summary.tests} test(s) across ${summary.files} file(s) (${Math.round(raw.length / 1024)} KB, ${Date.now() - startedAt} ms)`);
  }
}


/** A batch with no finished file for this long gets a "still running" warning. */
const SLOW_BATCH_WARN_MS = 60_000;

function secondsSince(t: number): string {
  return `${((Date.now() - t) / 1000).toFixed(1)}s`;
}


/** Comparison key for a file path: normalised, and case-insensitive on Windows. */
function pathKey(filePath: string): string {
  const p = path.normalize(filePath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * The file a failed Jest run could not open, when it no longer exists — a
 * test created and deleted it while Jest's haste map crawled the project.
 * Undefined for any other failure.
 */
export function vanishedFile(output: string): string | undefined {
  for (const m of output.matchAll(/ENOENT: no such file or directory, (?:open|stat|lstat|scandir|realpath) '([^']+)'/g)) {
    if (!fs.existsSync(m[1])) { return m[1]; }
  }
  return undefined;
}

/**
 * Writes a generated Jest config where every batch and session of the project
 * finds the same file. Jest names its transform cache and its file map after
 * the config's path, so a new path per batch meant every batch compiled every
 * file again and re-crawled the project (and left one cache folder per batch
 * on disk). The name is the content's hash: a changed project config or
 * extension gets a new file, never a stale one. The text must therefore hold
 * nothing that changes per batch or session (those go in the environment).
 * @returns the config's path
 */
export function writeStableConfig(dir: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
  const file = path.join(dir, `ltr-jest-config-${hash}.js`);
  if (!fs.existsSync(file)) {
    // Parallel batches may write it at once: write aside, then rename (atomic).
    const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return file;
}
