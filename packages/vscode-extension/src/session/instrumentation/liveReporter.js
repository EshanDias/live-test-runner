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
  }

  // Jest 27+ calls onTestFileResult; Jest ≤26 calls onTestResult.
  // Both are defined here so the reporter works with any Jest version.
  onTestFileResult(test, testResult) { this._handleResult(testResult); }
  onTestResult(test, testResult) { this._handleResult(testResult); }

  _handleResult(testResult) {
    if (!this._outputFile) { return; }
    if (this._reported.has(testResult.testFilePath)) { return; }
    this._reported.add(testResult.testFilePath);

    // Log a summary to stderr so it appears in the extension Output channel
    const filePath = testResult.testFilePath || '(unknown)';
    const passed = testResult.numPassingTests || 0;
    const failed = testResult.numFailingTests || 0;
    const skipped = testResult.numPendingTests || 0;
    const fileStatus = testResult.testExecError ? 'EXEC_ERROR' : (failed > 0 ? 'FAIL' : 'PASS');
    process.stderr.write(`[LTR][Reporter] ${fileStatus} ${filePath} — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    if (testResult.testExecError) {
      const execErr = testResult.testExecError;
      process.stderr.write(`[LTR][Reporter] testExecError message: ${String(execErr.message || execErr)}\n`);
      if (execErr.stack) {
        String(execErr.stack).split('\n').slice(0, 15).forEach((l) =>
          process.stderr.write(`[LTR][Reporter]   ${l}\n`));
      }
    }
    (testResult.testResults || []).forEach((tc) => {
      if (tc.status === 'failed') {
        process.stderr.write(`[LTR][Reporter]   FAIL "${tc.fullName || tc.title}"\n`);
        (tc.failureMessages || []).forEach((msg) => {
          const lines = String(msg).split('\n').slice(0, 10);
          lines.forEach((line) => process.stderr.write(`[LTR][Reporter]     ${line}\n`));
        });
      }
    });

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
    } catch (_) {}
  }

  onRunStart() {}
  onTestStart() {}
  onRunComplete() {}
  getLastError() {}
}

module.exports = LiveReporter;
