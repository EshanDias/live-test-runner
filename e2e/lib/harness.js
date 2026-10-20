'use strict';
/** Helpers shared by the e2e scenarios. Runs inside the extension host. */
const { execFileSync } = require('child_process');
const path = require('path');

class Tester {
  constructor() {
    this.checks = [];
    this.lines = [];
  }
  check(name, ok, detail) {
    this.checks.push({ name, ok: !!ok, detail: ok ? undefined : detail });
    return !!ok;
  }
  eq(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  info(msg) {
    this.lines.push(msg);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { timeout = 60_000, interval = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) { return v; }
    if (Date.now() > end) { throw new Error(`timed out after ${timeout} ms waiting for ${what}`); }
    await sleep(interval);
  }
}

async function waitForDiscovery(api) {
  await waitFor(() => api.discovery.hasCompleted && !api.discovery.isDiscovering, { what: 'discovery', timeout: 120_000 });
}

/** Every node in the store, across all files. */
function allNodes(api) {
  const out = [];
  for (const f of api.store.getAllFiles()) { out.push(...api.store.getFileNodes(f.fileId)); }
  return out;
}

function nodesWithStatus(api, status) {
  return allNodes(api).filter((n) => n.status === status);
}

function fileBySuffix(api, suffix) {
  const norm = (p) => p.replace(/\\/g, '/');
  const f = api.store.getAllFiles().find((x) => norm(x.filePath).endsWith(norm(suffix)));
  if (!f) { throw new Error(`no file ending in ${suffix} in the store`); }
  return f;
}

function nodeByName(api, fileSuffix, fullName) {
  const f = fileBySuffix(api, fileSuffix);
  const n = api.store.getFileNodes(f.fileId).find((x) => x.fullName === fullName);
  if (!n) {
    const names = api.store.getFileNodes(f.fileId).map((x) => `${x.type}:${x.fullName}`).join(' | ');
    throw new Error(`no node "${fullName}" in ${fileSuffix}; have: ${names}`);
  }
  return n;
}

/**
 * Observer that records every lifecycle event together with how many tests
 * were still "running" at that moment.
 */
function recordEvents(api) {
  const events = [];
  const snap = (type, extra) => events.push({ type, at: Date.now(), running: nodesWithStatus(api, 'running').length, ...extra });
  const rec = {
    onSessionStarted: () => snap('session-started'),
    onSessionStopped: () => snap('session-stopped'),
    onRunStarted: (p) => snap('run-started', { fileCount: p.fileCount }),
    onFilesRerunning: (ids) => snap('files-rerunning', { files: ids.length }),
    onFileResult: (fp) => snap('file-result', { file: path.basename(fp) }),
    onRunFinished: (p) => snap('run-finished', { payload: p }),
    onRunProgress: (completed, total, failed) => events.push({ type: 'run-progress', at: Date.now(), completed, total, failed }),
    dispose() {},
  };
  api.observers.push(rec);
  return {
    events,
    stop() { const i = api.observers.indexOf(rec); if (i >= 0) { api.observers.splice(i, 1); } },
    of(type) { return events.filter((e) => e.type === type); },
  };
}

function rawMark(api) { return api.rawOutput.length; }
function rawSince(api, mark) { return api.rawOutput.slice(mark); }

/** Jest's "Tests: 1 passed, 5 skipped, 6 total" lines in raw output. */
function jestTestSummaries(lines) {
  return lines
    .map((l) => /Tests:\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => {
      const counts = {};
      for (const part of m[1].split(',')) {
        const mm = /(\d+)\s+(\w+)/.exec(part.trim());
        if (mm) { counts[mm[2]] = Number(mm[1]); }
      }
      return counts;
    });
}

/** Extension log lines (debug and above) written since `sinceIso`. */
function logsSince(api, sinceIso) {
  return api.logger.recentLines().filter((l) => l.slice(0, 24) >= sinceIso);
}

/**
 * Processes whose command line contains `marker` and looks like Jest — used to
 * check that Stop really killed everything.
 */
function jestProcesses(marker) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // Paths may differ in drive-letter case and separators — compare loosely.
      const norm = (s) => s.toLowerCase().replace(/\\\\/g, '\\').replace(/\//g, '\\');
      const m = norm(marker);
      return out.split(/\r?\n/).filter((l) => norm(l).includes(m) && isJest(l));
    }
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter((l) => l.includes(marker) && isJest(l));
  } catch {
    return [];
  }
}

/** A Jest process (node running jest / react-scripts) — not VS Code or the probe itself. */
function isJest(cmdLine) {
  return /[\\/](jest|jest-cli|react-scripts)[\\/]bin[\\/]|[\\/]\.bin[\\/]jest|jest-worker|processChild/i.test(cmdLine) &&
    !/Code(\.exe)?["\s]|extensionDevelopmentPath|powershell/i.test(cmdLine);
}

/** Save `filePath` through VS Code after applying `edit(text) → text`, so onDidSaveTextDocument fires. */
async function editAndSave(vscode, filePath, edit) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const text = doc.getText();
  const next = edit(text);
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
  await vscode.workspace.applyEdit(we);
  await doc.save();
}

/** Summary of a file's test statuses: { passed: 3, skipped: 1 } */
function statusCounts(api, fileSuffix) {
  const f = fileBySuffix(api, fileSuffix);
  const counts = {};
  for (const n of api.store.getFileNodes(f.fileId)) {
    if (n.type !== 'test') { continue; }
    counts[n.status] = (counts[n.status] || 0) + 1;
  }
  return counts;
}

function isoNow() { return new Date().toISOString(); }

module.exports = {
  Tester, sleep, waitFor, waitForDiscovery, allNodes, nodesWithStatus, fileBySuffix, nodeByName,
  recordEvents, rawMark, rawSince, jestTestSummaries, logsSince, jestProcesses, editAndSave,
  statusCounts, isoNow,
};
