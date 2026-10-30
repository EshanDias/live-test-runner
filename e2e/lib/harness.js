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

/** Processes whose command line contains `marker` (or its real path) and runs Vitest (its CLI or a worker). */
function vitestProcesses(marker) {
  let real = marker;
  try { real = require('fs').realpathSync.native(marker); } catch { /* keep marker */ }
  const has = (l) => l.includes(marker) || l.includes(real);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const norm = (s) => s.toLowerCase().replace(/\\\\/g, '\\').replace(/\//g, '\\');
      const m = norm(marker);
      const r = norm(real);
      return out.split(/\r?\n/).filter((l) => (norm(l).includes(m) || norm(l).includes(r)) && isVitest(l));
    }
    // Vitest renames its processes (process.title): the CLI shows as
    // "node (vitest)", workers as "node (vitest 3)" — the path is gone from
    // `ps`, so those titles count too (e2e runs one workspace at a time).
    const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter((l) => (has(l) && isVitest(l)) || /^\s*\d+\s+node \(vitest( \d+)?\)/.test(l));
  } catch {
    return [];
  }
}

/** Python processes running pytest for `marker` (the workspace — its .venv's python is in the command line). */
function pytestProcesses(marker) {
  let real = marker;
  try { real = require('fs').realpathSync.native(marker); } catch { /* keep marker */ }
  const isPytest = (l) => / -m pytest\b/.test(l) && !/Code(\.exe)?["\s]|extensionDevelopmentPath|powershell/i.test(l);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }",
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const norm = (x) => x.toLowerCase().replace(/\\\\/g, '\\').replace(/\//g, '\\');
      return out.split(/\r?\n/).filter((l) => (norm(l).includes(norm(marker)) || norm(l).includes(norm(real))) && isPytest(l));
    }
    // A framework-build Python on macOS (CI's setup-python) re-executes itself as
    // …/Python.app/…/Python: the workspace's .venv path is gone from `ps`, so our
    // own runs (`-m pytest -p ltr_pytest`) count too — e2e runs one workspace at a time.
    const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter((l) => isPytest(l) && (l.includes(marker) || l.includes(real) || / -m pytest -p ltr_pytest\b/.test(l)));
  } catch {
    return [];
  }
}

function isVitest(cmdLine) {
  return /[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?vitest[\\/]/i.test(cmdLine) &&
    !/Code(\.exe)?["\s]|extensionDevelopmentPath|powershell/i.test(cmdLine);
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

/** statusCounts with the keys sorted (stable to compare with t.eq). */
function sortedCounts(api, fileSuffix) {
  const c = statusCounts(api, fileSuffix);
  return Object.fromEntries(Object.keys(c).sort().map((k) => [k, c[k]]));
}

function isoNow() { return new Date().toISOString(); }

/**
 * Runs the project's tests with plain Jest — the way `npm test` would, honouring
 * the config flags of its test script — and returns per-file counts:
 * Map<path, { passed, failed, skipped }> (see jestJsonCounts).
 */
function plainJestCounts(workspace) {
  return jestJsonCounts(plainJestJson(workspace), workspace);
}

/** The raw `jest --json` result of a plain run of the project's own Jest (see plainJestCounts). */
function plainJestJson(workspace) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  // The runner's own parser for the test script (built by `pnpm build`).
  const { testScriptJestArgs, jestNodeEnv } = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'framework', 'jestConfig.js'));
  const scriptArgs = testScriptJestArgs(workspace);
  const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
  const cra = /react-scripts/.test(pkg.scripts?.test || '');
  const resolveFrom = (id) => require.resolve(id, { paths: [workspace] });
  const entry = cra
    ? path.join(path.dirname(resolveFrom('react-scripts/package.json')), 'bin', 'react-scripts.js')
    : path.join(path.dirname(resolveFrom('jest/package.json')), 'bin', 'jest.js');
  const out = path.join(os.tmpdir(), `ltr-e2e-plain-${process.pid}-${Date.now()}.json`);
  // NODE_OPTIONS from the test script (e.g. --experimental-vm-modules: Jest's ESM mode).
  const env = { ...process.env, CI: 'true', ...jestNodeEnv(workspace) };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  const r = spawnSync(node, [entry, ...(cra ? ['test'] : []), ...scriptArgs, '--watchAll=false', '--json', `--outputFile=${out}`],
    // A big project prints far more than spawnSync's 1 MB default buffer,
    // which kills Jest mid-run (exit null) — the jest monorepo does.
    { cwd: workspace, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 1 << 30 });
  if (!fs.existsSync(out)) {
    throw new Error(`plain Jest wrote no results (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error.message}` : ''}): ${(r.stderr || '').slice(-1500)}`);
  }
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  return json;
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

/**
 * The raw json-reporter result of a plain `vitest run` of the project's own
 * Vitest, with the config-relevant flags of its test script (like npm test).
 */
function plainVitestJson(workspace) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const runner = require(path.join(__dirname, '..', '..', 'packages', 'runner', 'dist', 'index.js'));
  const adapter = new runner.VitestAdapter();
  let entry = adapter.findInstall(workspace).entry;
  const out = path.join(os.tmpdir(), `ltr-e2e-plain-vitest-${process.pid}-${Date.now()}.json`);
  const env = { ...process.env, CI: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  // From the real path, as the extension spawns it (toSpawnPath): with a Windows
  // 8.3 short name (C:\Users\RUNNER~1) as cwd, Vite's server.fs check sees the
  // long name and refuses the project's own files (workspace file, components).
  // Vitest's own entry too: its internal files must have the same spelling.
  let cwd = workspace;
  try { cwd = fs.realpathSync.native(workspace); entry = fs.realpathSync.native(entry); } catch { /* as given */ }
  const r = spawnSync(node, [entry, 'run', ...adapter.getExtraArgs(workspace), '--reporter=json', `--outputFile=${out}`],
    { cwd, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 1 << 30 });
  if (!fs.existsSync(out)) {
    throw new Error(`plain Vitest wrote no results (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${(r.stderr || '').slice(-1500)}`);
  }
  const json = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);
  // For the report when the counts differ (not enumerable: the JSON stays as Vitest wrote it).
  Object.defineProperty(json, 'stderrTail', { value: String(r.stderr || '').slice(-2000) + String(r.stdout || '').slice(-2000) });
  return json;
}

/**
 * Per-file pass/fail/skip in the tree equal a plain `vitest run`. Files Vitest
 * could not load (no tests, a message) are left out — the extension fails
 * their discovered tests with the reason; check those separately.
 */
function checkMatchesPlainVitest(api, t, workspace, label = 'results match plain Vitest', json = plainVitestJson(workspace)) {
  const tail = json.stderrTail;
  json = { ...json, testResults: json.testResults.filter((f) => f.assertionResults.length > 0 || !f.message) };
  const want = jestJsonCounts(json, workspace);
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
      diffs.push(`${path.basename(file)}: vitest ${JSON.stringify(c)} vs extension ${JSON.stringify(got)}`);
    }
  }
  if ((diffs.length || want.size === 0) && tail) { diffs.push(`plain Vitest output (tail):\n${tail}`); }
  t.check(`${label} (${want.size} files)`, want.size > 0 && diffs.length === 0, diffs.slice(0, 21).join('\n') || 'no files');
}

/** The python of a workspace's .venv (fixtures and real-repo clones). */
function workspacePython(workspace) {
  const fs = require('fs');
  const win = process.platform === 'win32';
  for (const dir of ['.venv', 'venv']) {
    const p = win ? path.join(workspace, dir, 'Scripts', 'python.exe') : path.join(workspace, dir, 'bin', 'python');
    if (fs.existsSync(p)) { return p; }
  }
  throw new Error(`no .venv in ${workspace}`);
}

/**
 * A plain pytest run of the project (no Live Test Runner plugin, pytest's own
 * cache off) as per-test outcomes from its JUnit XML (xunit1 has the file of
 * each test): Map<file in the workspace's spelling, Map<"Class name", status>>.
 * Collection errors (a file that cannot be imported) are left out.
 */
function plainPytestResults(workspace, extraArgs = []) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const python = workspacePython(workspace);
  const out = path.join(os.tmpdir(), `ltr-e2e-plain-pytest-${process.pid}-${Date.now()}.xml`);
  // --continue-on-collection-errors, as the extension runs: a file that cannot be imported must not hide the others.
  // pytest's cache in a temp folder, as the extension runs (never `-p no:cacheprovider`: tests of the cache plugin itself differ).
  const cacheDir = path.join(os.tmpdir(), `ltr-e2e-plain-pytest-cache-${process.pid}-${Date.now()}`);
  const r = spawnSync(python, ['-m', 'pytest', '-o', `cache_dir=${cacheDir}`, '--continue-on-collection-errors', '-o', 'junit_family=xunit1', `--junitxml=${out}`, '-q', '--color=no', ...extraArgs],
    { cwd: workspace, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 1 << 30, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  let xml;
  try { xml = fs.readFileSync(out, 'utf8'); } catch {
    throw new Error(`plain pytest wrote no JUnit XML (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-1500)}`);
  }
  fs.unlinkSync(out);
  const toWorkspace = workspaceSpelling(workspace);
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const files = new Map();
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) { attrs[a[1]] = unescape(a[2]); }
    if (!attrs.file || !attrs.name) { continue; }
    const body = m[3] || '';
    if (/<error\b[^>]*message="collection failure/.test(body)) { continue; }
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const file = toWorkspace(path.resolve(workspace, attrs.file));
    const tests = files.get(file) ?? new Map();
    // classname "tests.test_cart.TestCart.TestNested" → the classes after the module.
    const modParts = attrs.file.replace(/\\/g, '/').replace(/\.py$/, '').split('/');
    const cls = (attrs.classname || '').split('.').slice(modParts.length).join(' ');
    const key = cls ? `${cls} ${attrs.name}` : attrs.name;
    // A teardown error is a second entry for the same test: failed wins.
    if (tests.get(key) !== 'failed') { tests.set(key, status); }
    files.set(file, tests);
  }
  return files;
}

/** Per-file pass / fail / skip in the tree equal a plain pytest run (see plainPytestResults). */
function checkMatchesPlainPytest(api, t, workspace, label = 'results match plain pytest', results = plainPytestResults(workspace), flaky = []) {
  const diffs = [];
  const isFlaky = (name) => flaky.some((f) => name === f || name.startsWith(`${f}[`));
  const flakyDiffs = [];
  for (const [file, tests] of results) {
    const key = api.store.findFileKey(file);
    if (!key) { diffs.push(`${path.basename(file)}: not in the tree`); continue; }
    const got = new Map(api.store.getFileNodes(key).filter((n) => n.type === 'test').map((n) => [n.fullName, n.status]));
    for (const [name, status] of tests) {
      if (got.get(name) === status) { continue; }
      const line = `${path.basename(file)} ${name}: pytest ${status} vs extension ${got.get(name) ?? 'missing'}`;
      (isFlaky(name) && got.has(name) ? flakyDiffs : diffs).push(line);
    }
    for (const [name, status] of got) {
      if (!tests.has(name)) { diffs.push(`${path.basename(file)} ${name}: extension ${status}, not reported by pytest`); }
    }
  }
  if (flakyDiffs.length) { t.info(`known-flaky tests differed (not counted): ${flakyDiffs.join('; ')}`); }
  t.check(`${label} (${results.size} files)`, results.size > 0 && diffs.length === 0, diffs.slice(0, 25).join('\n') || 'no files');
}

module.exports = {
  workspacePython, plainPytestResults, checkMatchesPlainPytest, sortedCounts, pytestProcesses,
  Tester, sleep, waitFor, waitForDiscovery, allNodes, nodesWithStatus, fileBySuffix, nodeByName,
  recordEvents, rawMark, rawSince, jestTestSummaries, logsSince, jestProcesses, editAndSave,
  statusCounts, isoNow, plainJestCounts, plainJestJson, jestJsonCounts, jestJsonRunsPerFile, checkMatchesPlainJest,
  plainVitestJson, checkMatchesPlainVitest, vitestProcesses,
};
