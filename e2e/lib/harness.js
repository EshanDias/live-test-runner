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
    // -A / -o args= work with both BSD (macOS) and procps (Linux) ps.
    const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

/**
 * Runs the project's tests with plain Jest — the way `npm test` would, honouring
 * the config flags of its test script — and returns per-file counts:
 * Map<path, { passed, failed, skipped }> (see jestJsonCounts).
 */
function plainJestCounts(workspace) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  // The runner's own parser for the test script (built by `pnpm build`).
  const { testScriptJestArgs } = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'framework', 'jestConfig.js'));
  const scriptArgs = testScriptJestArgs(workspace);
  const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  const cra = /react-scripts/.test(pkg.scripts?.test || '');
  const resolveFrom = (id) => require.resolve(id, { paths: [workspace] });
  const entry = cra
    ? path.join(path.dirname(resolveFrom('react-scripts/package.json')), 'bin', 'react-scripts.js')
    : path.join(path.dirname(resolveFrom('jest/package.json')), 'bin', 'jest.js');
  const out = path.join(os.tmpdir(), `ltr-e2e-plain-${process.pid}-${Date.now()}.json`);
  const env = { ...process.env, CI: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  const r = spawnSync(node, [entry, ...(cra ? ['test'] : []), ...scriptArgs, '--watchAll=false', '--json', `--outputFile=${out}`],
    { cwd: workspace, env, encoding: 'utf8', timeout: 20 * 60_000 });
  if (!fs.existsSync(out)) {
    throw new Error(`plain Jest wrote no results (exit ${r.status}): ${(r.stderr || '').slice(-1500)}`);
  }
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  return jestJsonCounts(json, workspace);
}

/**
 * Maps a path Jest reported (its real path: symlinks resolved, Windows 8.3
 * short names such as RUNNER~1 expanded) to the workspace's spelling, which is
 * what the extension's store uses. Case- and slash-insensitive on Windows.
 */
function workspaceSpelling(workspace) {
  const fs = require('fs');
  const win = process.platform === 'win32';
  const cmp = (p) => (win ? p.replace(/\\/g, '/').toLowerCase() : p);
  let realRoot;
  try { realRoot = fs.realpathSync.native(workspace); } catch { return (p) => p; }
  const real = cmp(realRoot);
  const sep = win ? '/' : path.sep;
  return (p) => (cmp(p).startsWith(real + sep) ? workspace + p.slice(realRoot.length) : p);
}

/**
 * Per-file counts from a `jest --json` result:
 * Map<path in the workspace's spelling, { passed, failed, skipped }>.
 * Jest reports real paths, and the workspace may be opened through a symlink
 * (see workspaceSpelling). Case is kept — store.findFileKey ignores it
 * only for Windows paths, and macOS paths such as /Users/… are mixed-case.
 */
function jestJsonCounts(json, workspace) {
  const toWorkspace = workspaceSpelling(workspace);
  // A file run by several Jest projects (e.g. jsdom + node) is reported once
  // per project; like the extension, a test counts once, failed if it failed
  // in any project and passed if it ran in any.
  const rank = { failed: 2, passed: 1 };
  const perFile = new Map(); // file → Map<fullName#n, status>
  for (const tr of json.testResults) {
    const file = toWorkspace(tr.name);
    const tests = perFile.get(file) ?? new Map();
    const seen = new Map();
    for (const a of tr.assertionResults) {
      const n = seen.get(a.fullName) ?? 0;
      seen.set(a.fullName, n + 1);
      const key = `${a.fullName}#${n}`;
      const prev = tests.get(key);
      if (!prev || (rank[a.status] ?? 0) > (rank[prev] ?? 0)) { tests.set(key, a.status); }
    }
    perFile.set(file, tests);
  }
  const counts = new Map();
  for (const [file, tests] of perFile) {
    const c = { passed: 0, failed: 0, skipped: 0 };
    for (const s of tests.values()) {
      if (s === 'passed') { c.passed++; } else if (s === 'failed') { c.failed++; } else { c.skipped++; }
    }
    counts.set(file, c);
  }
  return counts;
}

/** How many times a `jest --json` result ran each file (once per Jest project that includes it). */
function jestJsonRunsPerFile(json, workspace) {
  const toWorkspace = workspaceSpelling(workspace);
  const runs = new Map();
  for (const tr of json.testResults) {
    const file = toWorkspace(tr.name);
    runs.set(file, (runs.get(file) ?? 0) + 1);
  }
  return runs;
}

/**
 * The strongest end-to-end check: every file's pass / fail / skip counts in
 * the extension equal what plain Jest reports for the same project.
 */
function checkMatchesPlainJest(api, t, workspace, label = 'results match plain Jest') {
  const want = plainJestCounts(workspace);
  const diffs = [];
  for (const [file, c] of want) {
    const key = api.store.findFileKey(file);
    if (!key) { diffs.push(`${path.basename(file)}: not in the tree`); continue; }
    const got = { passed: 0, failed: 0, skipped: 0, other: 0 };
    for (const n of api.store.getFileNodes(key)) {
      if (n.type !== 'test') { continue; }
      if (n.status in got) { got[n.status]++; } else { got.other++; }
    }
    if (got.passed !== c.passed || got.failed !== c.failed || got.skipped !== c.skipped || got.other) {
      diffs.push(`${path.basename(file)}: jest ${JSON.stringify(c)} vs extension ${JSON.stringify(got)}`);
    }
  }
  t.check(`${label} (${want.size} files)`, want.size > 0 && diffs.length === 0, diffs.slice(0, 20).join('\n') || 'no files');
}

module.exports = {
  Tester, sleep, waitFor, waitForDiscovery, allNodes, nodesWithStatus, fileBySuffix, nodeByName,
  recordEvents, rawMark, rawSince, jestTestSummaries, logsSince, jestProcesses, editAndSave,
  statusCounts, isoNow, plainJestCounts, jestJsonCounts, jestJsonRunsPerFile, checkMatchesPlainJest,
};
