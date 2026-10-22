import { RunResult } from '../types';

/** An empty result with the given pass/fail state and error messages — any framework. */
export function emptyRunResult(passed: boolean, errors: string[]): RunResult {
  return {
    passed,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    fileResults: [],
    errors,
  };
}

/** Merges several RunResults into one (used for chunked multi-file runs) — any framework. */
export function mergeRunResults(results: RunResult[]): RunResult {
  return {
    passed: results.every((r) => r.passed),
    numPassedTests: results.reduce((s, r) => s + r.numPassedTests, 0),
    numFailedTests: results.reduce((s, r) => s + r.numFailedTests, 0),
    numPendingTests: results.reduce((s, r) => s + r.numPendingTests, 0),
    fileResults: results.flatMap((r) => r.fileResults),
    errors: results.flatMap((r) => r.errors),
  };
}
