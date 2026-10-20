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

// The real fs, taken before the test file loads: tests often jest.mock('fs'),
// and a require('fs') in afterAll would then get the mock.
const _realFs = (typeof jest !== 'undefined' && jest.requireActual) ? jest.requireActual('fs') : require('fs');

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
require(((typeof jest !== 'undefined' && jest.requireActual) ? jest.requireActual('path') : require('path')).join(__dirname, 'sessionTraceRuntime.js'));
const _ltrTestPath = (() => {
  try { return expect.getState().testPath; } catch (_) { return undefined; }
})();
const _strace = global.__strace;

// Heartbeats for the extension's hang watchdog: a test that never ends (a
// synchronous infinite loop blocks Jest's own testTimeout) is told apart from
// a file that is merely slow to load (cold transform cache).
const _heartbeatFile = process.env.LTR_REPORTER_FILE;
function _heartbeat(ltrEvent, name) {
  if (!_heartbeatFile || !_ltrTestPath) { return; }
  try {
    _realFs.appendFileSync(_heartbeatFile, JSON.stringify({ ltrEvent, testFilePath: _ltrTestPath, name, at: Date.now() }) + '\n', 'utf8');
  } catch (_) { /* diagnostics only */ }
}

if (_strace && _strace.beginTest && _ltrTestPath) {
  _strace.beginFile(_ltrTestPath);
  // This file is the FIRST setupFilesAfterEnv entry, so this beforeEach runs
  // before the project's own (e.g. in setupTests.js) and their hits count for
  // the test.
  beforeEach(() => {
    let name;
    try { name = expect.getState().currentTestName; } catch (_) { name = undefined; }
    _heartbeat('test-start', name);
    _strace.beginTest(name || '<unknown>', _ltrTestPath);
  });
  afterEach(() => {
    _strace.endTest(_ltrTestPath);
    _heartbeat('test-end');
  });
} else {
  _ltrLog('debug', 'trace: no test path in expect.getState() — per-test trace disabled for this file');
}

afterAll(() => {
  if (_strace && _strace.finish) { _strace.finish(); }
  const covOutputFile = process.env.COVERAGE_OUTPUT_FILE;
  if (!covOutputFile) {
    _ltrLog('warn', 'coverage: COVERAGE_OUTPUT_FILE is not set — coverage will be missing');
    return;
  }
  const covEntries = globalThis.__cov ? Object.keys(globalThis.__cov).length : 0;
  // Empty is normal for test files that import no instrumented source file.
  if (covEntries === 0) { return; }
  try {
    _realFs.appendFileSync(
      covOutputFile,
      JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n',
      'utf8',
    );
    _ltrLog('trace', `coverage: flushed ${covEntries} file(s) (pid ${process.pid})`);
  } catch (_e) {
    _ltrLog('error', `coverage: could not write ${covOutputFile} — ${_e.message}`);
  }
});
