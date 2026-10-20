'use strict';
/**
 * liveReporter.js — custom Jest reporter for streaming per-file results.
 *
 * Jest calls onTestFileResult as each test file completes within a batch run.
 * We append a compact JSON record to LTR_REPORTER_FILE so the parent process
 * can poll it and fire UI updates without waiting for the whole batch to finish.
 *
 * Record shape mirrors FileRunResult from @live-test-runner/runner/types.
 */

const fs = require('fs');

class LiveReporter {
  constructor(globalConfig, reporterOptions) {
    this._outputFile =
      (reporterOptions && reporterOptions.outputFile) ||
      process.env.LTR_REPORTER_FILE;
    // Track reported files to prevent double-reporting when both onTestResult
    // and onTestFileResult fire (Jest 27 calls both; we define both for compat).
    this._reported = new Set();
    this._started = new Set();
  }

  // Jest 28+ calls onTestFileStart; older versions call onTestStart.
  // A small "start" record lets the extension tell which file a long-running
  // batch is on — the difference between "slow" and "stuck".
  onTestFileStart(test) { this._handleStart(test); }
  onTestStart(test) { this._handleStart(test); }

  _handleStart(test) {
    const testFilePath = test && test.path;
    if (!this._outputFile || !testFilePath || this._started.has(testFilePath)) { return; }
    this._started.add(testFilePath);
    try {
      fs.appendFileSync(this._outputFile, JSON.stringify({ ltrEvent: 'start', testFilePath, at: Date.now() }) + '\n', 'utf8');
    } catch (_) { /* best effort — only used for diagnostics */ }
  }

  // Jest 27+ calls onTestFileResult; Jest ≤26 calls onTestResult.
  // Both are defined here so the reporter works with any Jest version.
  onTestFileResult(test, testResult) { this._handleResult(testResult); }
  onTestResult(test, testResult) { this._handleResult(testResult); }

  _handleResult(testResult) {
    if (!this._outputFile) { return; }
    if (this._reported.has(testResult.testFilePath)) { return; }
    this._reported.add(testResult.testFilePath);

    // No logging here: Jest's default reporter already prints PASS/FAIL and
    // failure details to the raw output, and the extension logs a WARN for
    // files that failed to execute (testExecError → failureMessage below).

    const record = {
      testFilePath: testResult.testFilePath,
      status:
        testResult.testExecError || testResult.numFailingTests > 0
          ? 'failed'
          : 'passed',
      failureMessage: testResult.testExecError
        ? String(testResult.testExecError.message || '')
        : undefined,
      testResults: (testResult.testResults || []).map((tc) => ({
        ancestorTitles: tc.ancestorTitles || [],
        title: tc.title || '',
        fullName: tc.fullName || '',
        status: tc.status || 'failed',
        duration: tc.duration != null ? tc.duration : undefined,
        failureMessages: tc.failureMessages || [],
        location: tc.location || undefined,
      })),
      console: (testResult.console || []).map((c) => ({
        message: String(c.message || ''),
        type: String(c.type || 'log'),
        origin: String(c.origin || ''),
      })),
      startTime: testResult.perfStats ? testResult.perfStats.start : undefined,
      endTime: testResult.perfStats ? testResult.perfStats.end : undefined,
    };
    try {
      fs.appendFileSync(
        this._outputFile,
        JSON.stringify(record) + '\n',
        'utf8',
      );
    } catch (e) {
      // Without this record the file shows as "no result" and is rerun via the fallback path.
      process.stderr.write(`[LTR:error] liveReporter could not write ${this._outputFile}: ${String(e.message).replace(/\s*\r?\n\s*/g, ' ↵ ')}\n`);
    }
  }

  onRunStart() {}
  onRunComplete() {}
  getLastError() {}
}

module.exports = LiveReporter;
