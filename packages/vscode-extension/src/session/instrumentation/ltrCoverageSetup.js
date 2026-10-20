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

// ── Per-test trace context ──────────────────────────────────────────────────
// Test files are deliberately not instrumented (jest.mock hoisting), so the
// enterTest()/exitTest() calls that tell the trace runtime which test a source
// line ran for are made here instead. Without them no hit was ever recorded
// and smart reruns / "covering tests" never worked (BUG-04).
//
//   setup → first test : 'H' context — module-level code of imported files
//   beforeEach…afterEach: 'T' context — that test (and its beforeEach hooks)
//   between tests       : 'H' context — beforeAll / afterAll hooks
// 'H' hits count for every test in the file.
require(require('path').join(__dirname, 'sessionTraceRuntime.js'));
const _ltrTestPath = (() => {
  try { return expect.getState().testPath; } catch (_) { return undefined; }
})();
const _strace = global.__strace;
if (_strace && _ltrTestPath) {
  _strace.enterHook('file', _ltrTestPath);
  beforeEach(() => {
    _strace.exitHook();
    let name;
    try { name = expect.getState().currentTestName; } catch (_) { name = undefined; }
    _strace.enterTest(name || '<unknown>', _ltrTestPath);
  });
  afterEach(() => {
    _strace.exitTest();
    _strace.enterHook('hook', _ltrTestPath);
  });
} else {
  _ltrLog('debug', 'trace: no test path in expect.getState() — per-test trace disabled for this file');
}

afterAll(() => {
  if (_strace) { _strace.exitHook(); }
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
