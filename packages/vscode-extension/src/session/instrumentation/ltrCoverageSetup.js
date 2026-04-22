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

afterAll(() => {
  const covOutputFile = process.env.COVERAGE_OUTPUT_FILE;
  if (!covOutputFile || !globalThis.__cov) { return; }
  try {
    require('fs').appendFileSync(
      covOutputFile,
      JSON.stringify({ workerPid: process.pid, cov: globalThis.__cov }) + '\n',
      'utf8',
    );
  } catch (_e) {}
});
