'use strict';
/**
 * ltrCoverageSetup.js — Jest setupFilesAfterEnv entry.
 *
 * Registers a global afterAll that flushes coverage counters to
 * COVERAGE_OUTPUT_FILE after every test file completes.  This is necessary
 * because Jest kills worker processes via SIGKILL (with --forceExit), which
 * bypasses process.on('exit') handlers entirely.  Running inside afterAll
 * guarantees we flush while the worker is still alive and in a clean state.
 *
 * globalThis.__cov accumulates across all test files in the same worker, so
 * each flush contains the superset of coverage up to that point.
 * _parseCoverage merges records with Math.max so duplicate flushes are safe.
 */

// Log protocol: "[LTR:<level>] msg" lines on stderr are routed by the
// extension's Executor into the "Live Test Runner" log at that level.
const _LTR_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const _ltrMin = _LTR_RANK[process.env.LTR_LOG_LEVEL] ?? _LTR_RANK.info;
function _ltrLog(level, msg) {
  if (_LTR_RANK[level] < _ltrMin) { return; }
  // One line per message so continuation lines don't leak into raw output.
  const text = String(msg).replace(/\s*Require stack:[\s\S]*$/, '').replace(/\s*\r?\n\s*/g, ' ↵ ');
  process.stderr.write(`[LTR:${level}] ${text}\n`);
}

// Raise React Testing Library's waitFor timeout to match testTimeout.
// The sessionTraceTransform instruments every statement, which slows React
// renders significantly. The default 1000ms asyncUtilTimeout causes waitFor()
// calls to fail in async tests that are borderline under normal conditions.
try {
  const configure = require('@testing-library/react').configure
    || require('@testing-library/dom').configure;
  if (typeof configure === 'function') {
    configure({ asyncUtilTimeout: 10000 });
  }
} catch (_) { /* RTL not present in this project */ }

afterAll(() => {
  const covOutputFile = process.env.COVERAGE_OUTPUT_FILE;
  if (!covOutputFile) {
    _ltrLog('warn', 'coverage: COVERAGE_OUTPUT_FILE is not set — coverage will be missing');
    return;
  }
  const covEntries = globalThis.__cov ? Object.keys(globalThis.__cov).length : 0;
  // Empty is normal for test files that import no instrumented source file.
  if (covEntries === 0) { return; }
  try {
    require('fs').appendFileSync(
      covOutputFile,
      JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n',
      'utf8',
    );
    _ltrLog('trace', `coverage: flushed ${covEntries} file(s) (pid ${process.pid})`);
  } catch (_e) {
    _ltrLog('error', `coverage: could not write ${covOutputFile} — ${_e.message}`);
  }
});
