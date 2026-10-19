'use strict';
/**
 * Runs inside the VS Code extension host (--extensionTestsPath). Loads the
 * scenario named by LTR_E2E_SCENARIO, runs it, and writes a JSON report that
 * e2e/run.js prints. VS Code exits when run() settles.
 */
const fs = require('fs');
const vscode = require('vscode');
const { Tester } = require('./harness');

exports.run = async function run() {
  const t = new Tester();
  let error;
  try {
    const ext = vscode.extensions.getExtension('EshLabs.live-test-runner');
    if (!ext) { throw new Error('extension EshLabs.live-test-runner is not loaded'); }
    const api = await ext.activate();
    if (!api || !api.store) { throw new Error('extension did not return the e2e API (is LTR_E2E set?)'); }
    const scenario = require(process.env.LTR_E2E_SCENARIO);
    await scenario.run({ api, t, vscode, workspace: process.env.LTR_E2E_WORKSPACE });
  } catch (err) {
    error = err && err.stack ? err.stack : String(err);
  }
  try {
    const api = vscode.extensions.getExtension('EshLabs.live-test-runner')?.exports;
    if (api && api.session && api.session.isActive()) {
      await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    }
  } catch { /* best effort */ }

  // Context for failures: the extension's own log and the raw Jest output.
  let logTail = [];
  let rawTail = [];
  try {
    const api = vscode.extensions.getExtension('EshLabs.live-test-runner')?.exports;
    logTail = api.logger.recentLines().filter((l) => /\[(info|warn|error)\]/.test(l)).slice(-80);
    rawTail = api.rawOutput.slice(-120);
  } catch { /* no api */ }

  fs.writeFileSync(process.env.LTR_E2E_REPORT, JSON.stringify({ checks: t.checks, log: t.lines, error, logTail, rawTail }, null, 2));
  if (error || t.checks.some((c) => !c.ok)) {
    throw new Error('scenario failed');
  }
};
