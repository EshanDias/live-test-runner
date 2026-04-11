/**
 * SessionTraceRunner — runs a test file with full instrumentation and writes
 * per-test JSONL trace files to the session trace directory.
 *
 * This is entirely separate from JestInstrumentedRunner (which serves the
 * Timeline Debugger). It uses sessionTraceTransform.js and sessionTraceRuntime.js.
 *
 * Flow for each file:
 *  1. Write a temp Jest config that injects sessionTraceTransform for all project files.
 *  2. Set SESSION_TRACE_FILE env var — the runtime writes all steps there.
 *  3. Run Jest on the full file (no --testNamePattern — all tests execute in order).
 *  4. Read the single raw JSONL, partition steps by testName.
 *  5. Write one JSONL file per test case into the session trace directory.
 *  6. Update ExecutionTraceStore (trace index + coverage index).
 *  7. Clean up temp files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Executor, BinaryResolver } from '@live-test-runner/runner';
import { LTR_TMP_DIR } from '../constants';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';

// At runtime __dirname is out/ (the esbuild output directory).
// esbuild.js copies sessionTraceTransform.js → out/instrumentation/.
const SESSION_TRANSFORM_PATH = path.resolve(
  __dirname,
  'instrumentation',
  'sessionTraceTransform.js',
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One line from the raw JSONL trace file */
interface RawStep {
  type: 'STEP' | 'VAR' | 'LOG';
  line?: number;
  file?: string;
  name?: string;
  value?: unknown;
  level?: string;
  args?: string[];
  context: string | null;
  testName: string | null;
}

export class SessionTraceRunner {
  private readonly _executor = new Executor();
  private readonly _binaryResolver = new BinaryResolver();

  /**
   * Run a test file with instrumentation. Partitions the trace per test case
   * and writes JSONL files into traceDir. Updates the ExecutionTraceStore.
   *
   * @param filePath       Absolute path to the test file
   * @param projectRoot    Project root (used for binary resolution + config)
   * @param traceDir       Directory where per-test JSONL files will be written
   * @param traceStore     Store to update with trace index + coverage data
   * @param log            Optional log callback (for output channel)
   */
  async runFile(options: {
    filePath: string;
    projectRoot: string;
    traceDir: string;
    traceStore: ExecutionTraceStore;
    log?: (msg: string) => void;
  }): Promise<void> {
    const { filePath, projectRoot, traceDir, traceStore, log } = options;
    const emit = log ?? (() => {});

    // Ensure the per-session trace dir exists (LTR_TMP_DIR itself is created at activation)
    fs.mkdirSync(traceDir, { recursive: true });

    const rand = Math.random().toString(36).slice(2);
    const ts   = Date.now();

    // Temp file: the raw JSONL from this file's run (all tests combined)
    const rawTraceFile = path.join(LTR_TMP_DIR, `ltr-raw-${ts}-${rand}.jsonl`);

    // Temp Jest config
    const tempConfigPath = path.join(LTR_TMP_DIR, `ltr-session-cfg-${ts}-${rand}.js`);

    const escapedRoot = escapeRegex(projectRoot).replace(/\//g, '\\/');
    const srcTransformPattern = `^${escapedRoot}\\/(?!node_modules\\/).+\\.[jt]sx?$`;

    const configContent = `
'use strict';
// Temporary Jest config — Live Test Runner session trace
let baseConfig = {};
try {
  const e = require(${JSON.stringify(path.join(projectRoot, 'jest.config.js'))});
  baseConfig = (e && e.default) ? e.default : e;
} catch (_) {
  try {
    const e = require(${JSON.stringify(path.join(projectRoot, 'jest.config.cjs'))});
    baseConfig = (e && e.default) ? e.default : e;
  } catch (_) {
    try {
      const pkg = require(${JSON.stringify(path.join(projectRoot, 'package.json'))});
      if (pkg.jest) { baseConfig = pkg.jest; }
    } catch (_) {}
  }
}

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
    } catch(_) {
      presets = [];
    }
  }
  if (presets.length > 0) {
    fallbackTransform = { ['^.+\\\\.[jt]sx?$']: [babelJestPath, { configFile: false, presets }] };
  }
}

module.exports = {
  ...baseConfig,
  rootDir: ${JSON.stringify(projectRoot)},
  transform: {
    [${JSON.stringify(srcTransformPattern)}]: ${JSON.stringify(SESSION_TRANSFORM_PATH)},
    ...baseTransformObj,
    ...fallbackTransform,
  },
};
`;

    fs.writeFileSync(tempConfigPath, configContent, 'utf8');

    try {
      const binary = this._binaryResolver.resolve(projectRoot);
      emit(`[SessionTrace] Running instrumented: ${path.relative(projectRoot, filePath)}`);

      const result = await this._executor.run({
        binary,
        args: [
          '--watchAll=false',
          '--forceExit',
          '--no-bail',
          '--runTestsByPath',
          filePath,
          '--config',
          tempConfigPath,
        ],
        cwd: projectRoot,
        extraEnv: { SESSION_TRACE_FILE: rawTraceFile },
      });

      // Log all stderr so transform/runtime errors are visible in the output channel.
      if (result.stderr) {
        emit(`[SessionTrace] stderr for ${path.basename(filePath)}:\n${result.stderr.trim()}`);
      }
    } catch (err) {
      emit(`[SessionTrace] Jest run error: ${(err as Error).message}`);
      // Don't rethrow — a test failure is not a runner error; we still parse what we got
    } finally {
      try { fs.unlinkSync(tempConfigPath); } catch { /* ignore */ }
    }

    // Parse and partition the raw trace
    try {
      this._partitionAndStore(rawTraceFile, filePath, traceDir, traceStore, emit);
    } finally {
      try { fs.unlinkSync(rawTraceFile); } catch { /* ignore */ }
    }
  }

  // ── Private: partition raw JSONL into per-test files ──────────────────────

  private _partitionAndStore(
    rawTraceFile: string,
    testFilePath: string,
    traceDir: string,
    traceStore: ExecutionTraceStore,
    emit: (msg: string) => void,
  ): void {
    if (!fs.existsSync(rawTraceFile)) {
      emit(`[SessionTrace] No trace output produced for ${testFilePath}`);
      return;
    }

    const raw = fs.readFileSync(rawTraceFile, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    // Group steps by testName — preserving insertion order so steps stay ordered
    // Steps with testName === null belong to beforeAll/afterAll with no active test
    const byTest = new Map<string, RawStep[]>();
    // Track beforeAll steps (no testName) — included in every test in the suite
    const beforeAllSteps: RawStep[] = [];

    for (const line of lines) {
      let step: RawStep;
      try { step = JSON.parse(line) as RawStep; } catch { continue; }

      if (step.type === 'STEP' || step.type === 'VAR' || step.type === 'LOG') {
        if (step.testName) {
          let bucket = byTest.get(step.testName);
          if (!bucket) {
            bucket = [];
            byTest.set(step.testName, bucket);
          }
          bucket.push(step);
        } else if (step.context === 'beforeAll' || step.context === 'afterAll') {
          // Suite-level hooks — prepended to every test's trace
          beforeAllSteps.push(step);
        }
        // null context + null testName = top-level module code; skip
      }
    }

    // Write per-test JSONL files and update coverage index
    for (const [testName, steps] of byTest) {
      const testId = testName;  // stable key is the full test name
      const safeFileName = _safeFileName(testId);
      const traceFilePath = path.join(traceDir, `${safeFileName}.jsonl`);

      // Prepend beforeAll steps to every test's trace
      const allSteps = [...beforeAllSteps, ...steps];

      // Write the JSONL file
      const content = allSteps
        .map((s) => JSON.stringify(s))
        .join('\n') + '\n';
      fs.writeFileSync(traceFilePath, content, 'utf8');

      // Register in store
      traceStore.setTraceFile(testId, traceFilePath);

      // Accumulate coverage for each source file referenced in this test's steps
      for (const step of allSteps) {
        if (step.type === 'STEP' && step.file && step.line != null) {
          traceStore.addCoveredLines(step.file, [step.line]);
        }
      }
    }

    emit(`[SessionTrace] Traced ${byTest.size} test(s) from ${path.basename(testFilePath)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a test ID (full name) to a safe filename */
function _safeFileName(testId: string): string {
  return testId
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200);  // cap length
}
