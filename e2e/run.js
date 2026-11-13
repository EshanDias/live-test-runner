#!/usr/bin/env node
'use strict';
/**
 * End-to-end test launcher.
 *
 * Starts a real VS Code with the extension under development, opens a
 * workspace, and runs one scenario from e2e/scenarios inside the extension
 * host. Each scenario drives real commands (Start, Stop, ▶ Run, saves) against
 * real Jest processes and checks the extension's state.
 *
 *   node e2e/run.js <scenario> [<scenario> …]     run scenarios by name
 *   node e2e/run.js --all                         run every scenario whose workspace is available
 *
 * Environment:
 *   VSCODE_EXE              VS Code executable (default: the usual install location)
 *   LTR_E2E_CRA_REPO        a CRA project for scenarios that need one
 *   LTR_E2E_TSJEST_REPO     a ts-jest project for scenarios that need one
 *   LTR_E2E_EXTENSION_DIR   extension folder to test (default packages/vscode-extension;
 *                           an unpacked .vsix checks the published files)
 *
 * Fixtures (e2e/fixtures/<name>) are copied to a temp folder whose path
 * contains spaces, and `npm install` runs there once (re-run when
 * package.json changes). Build the extension first: `pnpm build`.
 */

const { spawn, execSync } = require('child_process');
const { killLeftovers } = require('./lib/leftovers');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { brokenPackages, emptiedPackages } = require('./lib/emptied');

const ROOT = path.resolve(__dirname, '..');
// LTR_E2E_EXTENSION_DIR: run against another copy of the extension, e.g. an
// unpacked .vsix (its `extension/` folder) to check what is actually published.
const EXT_DIR = process.env.LTR_E2E_EXTENSION_DIR
  ? path.resolve(process.env.LTR_E2E_EXTENSION_DIR)
  : path.join(ROOT, 'packages', 'vscode-extension');
const SCENARIO_DIR = path.join(__dirname, 'scenarios');
const WORK_ROOT = path.join(os.tmpdir(), 'ltr e2e'); // the space is deliberate

/**
 * VS Code to launch: VSCODE_EXE, a downloaded build (LTR_E2E_VSCODE=download
 * or `stable` / `insiders` / a version — as CI does), or the local install.
 */
async function resolveVscode() {
  const want = process.env.LTR_E2E_VSCODE;
  if (process.env.VSCODE_EXE) { return process.env.VSCODE_EXE; }
  const local = localVscodeExe();
  if (!want && fs.existsSync(local)) { return local; }
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const version = !want || want === 'download' ? 'stable' : want;
  console.log(`[e2e] using downloaded VS Code (${version})`);
  const exe = await downloadAndUnzipVSCode({ version, cachePath: path.join(ROOT, '.vscode-test') });
  // Newer macOS builds name the binary `Code`, older ones `Electron`;
  // @vscode/test-electron may return the old name.
  if (!fs.existsSync(exe) && process.platform === 'darwin') {
    const alt = ['Code', 'Electron'].map((n) => path.join(path.dirname(exe), n)).find((p) => fs.existsSync(p));
    if (alt) { return alt; }
  }
  return exe;
}

function localVscodeExe() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  }
  if (process.platform === 'darwin') {
    const dir = '/Applications/Visual Studio Code.app/Contents/MacOS';
    const name = ['Code', 'Electron'].find((n) => fs.existsSync(path.join(dir, n))) || 'Electron';
    return path.join(dir, name);
  }
  return '/usr/share/code/code';
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
  }
}

/**
 * A Python ≥ 3.12 to create fixture virtual environments with:
 * LTR_E2E_PYTHON, else the first of python3.14 / 3.13 / 3.12 / python3 /
 * python (py -3 on Windows) that is new enough.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  const candidates = process.env.LTR_E2E_PYTHON
    ? [[process.env.LTR_E2E_PYTHON]]
    : process.platform === 'win32'
      ? [['py', '-3'], ['python']]
      : [['python3.14'], ['python3.13'], ['python3.12'], ['python3'], ['python']];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    const [maj, min] = String(r.stdout || '').trim().split('.').map(Number);
    if (r.status === 0 && (maj > 3 || (maj === 3 && min >= 12))) { return [cmd, ...pre]; }
  }
  throw new Error('No Python 3.12+ found for the pytest fixtures — set LTR_E2E_PYTHON');
}

/** The python of a fixture's .venv. */
function venvPython(dir) {
  return process.platform === 'win32' ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
}

/** A fixture with requirements-e2e.txt gets a .venv (kept between runs, rebuilt when the file changes). */
function preparePythonEnv(src, dest) {
  const req = path.join(src, 'requirements-e2e.txt');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(req)).digest('hex');
  const stamp = path.join(dest, '.venv', '.ltr-e2e-stamp');
  if ((fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '') === hash) { return; }
  const [cmd, ...pre] = findPython();
  console.log(`[e2e] python venv + pip install in ${dest}`);
  fs.rmSync(path.join(dest, '.venv'), { recursive: true, force: true });
  execSync([cmd, ...pre, '-m', 'venv', '.venv'].map((a) => JSON.stringify(a)).join(' '), { cwd: dest, stdio: 'inherit' });
  execSync(`${JSON.stringify(venvPython(dest))} -m pip install --disable-pip-version-check -q -r requirements-e2e.txt`, { cwd: dest, stdio: 'inherit' });
  fs.writeFileSync(stamp, hash);
}

/** Empties a fixture copy, keeping every node_modules and .venv folder (at any depth) for the next run. */
function cleanKeepingEnvs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.venv') { continue; }
    const p = path.join(dir, entry.name);
    if (!entry.isDirectory()) { fs.rmSync(p, { force: true }); continue; }
    cleanKeepingEnvs(p);
    if (fs.readdirSync(p).length === 0) { fs.rmdirSync(p); }
  }
}

/** The fixture's folders (relative) with a requirements-e2e.txt — each gets its own .venv. */
function pythonEnvDirs(src, rel = '') {
  const dir = path.join(src, rel);
  const out = fs.existsSync(path.join(dir, 'requirements-e2e.txt')) ? [rel] : [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.venv') { out.push(...pythonEnvDirs(src, path.join(rel, entry.name))); }
  }
  return out;
}

/** The end of npm's newest debug log (why an install failed: npm prints only the error line). */
function printNpmDebugLog() {
  try {
    const cache = execSync('npm config get cache', { encoding: 'utf8' }).trim();
    const dir = path.join(cache, '_logs');
    // The newest install log (`npm config get cache` just above wrote one of its own).
    const newest = fs.readdirSync(dir).filter((f) => f.endsWith('-debug-0.log')).sort().reverse()
      .find((f) => /verbose title npm install/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    if (!newest) { return; }
    const lines = fs.readFileSync(path.join(dir, newest), 'utf8').split(/\r?\n/);
    console.log(`[e2e] npm debug log (${newest}, last 60 lines):\n` + lines.slice(-60).join('\n'));
  } catch { /* no log */ }
}

/** Fresh copy of a fixture (node_modules and .venv kept between runs). */
function prepareFixture(name) {
  const src = path.join(__dirname, 'fixtures', name);
  const dest = path.join(WORK_ROOT, `${name} project`);
  fs.mkdirSync(dest, { recursive: true });
  cleanKeepingEnvs(dest);
  copyDir(src, dest);
  for (const rel of pythonEnvDirs(src)) { preparePythonEnv(path.join(src, rel), path.join(dest, rel)); }
  if (!fs.existsSync(path.join(src, 'package.json'))) { return dest; }

  const pkgHash = crypto.createHash('sha1').update(fs.readFileSync(path.join(src, 'package.json'))).digest('hex');
  const stamp = path.join(dest, 'node_modules', '.ltr-e2e-stamp');
  let current = '';
  try { current = fs.readFileSync(stamp, 'utf8'); } catch { /* not installed yet */ }
  // macOS empties temp files untouched for 3 days (lib/emptied.js): any package that lost files since the install, install afresh.
  const brokenAtInstall = path.join(dest, 'node_modules', '.ltr-e2e-broken.json');
  let baseline = [];
  try { baseline = JSON.parse(fs.readFileSync(brokenAtInstall, 'utf8')); } catch { /* none recorded */ }
  const gone = current === pkgHash ? emptiedPackages(dest, baseline) : [];
  if (gone.length > 0) {
    console.log(`[e2e] ${gone.length} installed package(s) lost their files (${gone.slice(0, 3).join(', ')}…) — reinstalling`);
  }
  if (current !== pkgHash || gone.length > 0) {
    // From scratch: npm does not repair a half-emptied node_modules (and the stamp itself may be what was emptied).
    fs.rmSync(path.join(dest, 'node_modules'), { recursive: true, force: true });
    console.log(`[e2e] npm install in ${dest}`);
    try {
      execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dest, stdio: 'inherit' });
    } catch (err) {
      printNpmDebugLog();
      throw err;
    }
    fs.writeFileSync(stamp, pkgHash, { mode: 0o600 });
    fs.writeFileSync(brokenAtInstall, JSON.stringify(brokenPackages(dest)), { mode: 0o600 });
  }
  return dest;
}

function resolveWorkspace(spec) {
  if (spec.startsWith('fixture:')) { return prepareFixture(spec.slice('fixture:'.length)); }
  if (spec.startsWith('env:')) {
    const v = process.env[spec.slice(4)];
    return v && fs.existsSync(v) ? v : undefined;
  }
  return spec;
}

/** Child env without the variables that make Code.exe hand off to an already-running VS Code. */
function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(k)) { continue; }
    env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Per-scenario folders (user data, logs, report). Short on macOS / Linux:
 * VS Code puts an IPC socket in the user-data dir, and socket paths are
 * limited to ~103 characters there.
 */
const RUNS_ROOT = process.env.LTR_E2E_RUNS_DIR
  || (process.platform === 'win32' ? path.join(os.tmpdir(), 'ltr-e2e-runs') : '/tmp/ltr-e2e');

function runScenario(name, exe) {
  const file = path.join(SCENARIO_DIR, `${name}.js`);
  if (!fs.existsSync(file)) { throw new Error(`No scenario ${file}`); }
  const scenario = require(file);
  // An array: a multi-root window, one workspace folder per entry (scenario gets `workspaces`).
  const specs = Array.isArray(scenario.workspace) ? scenario.workspace : [scenario.workspace];
  const folders = specs.map(resolveWorkspace);
  if (folders.some((f) => !f)) {
    console.log(`[e2e] SKIP ${name}: workspace ${specs.join(', ')} is not available`);
    return Promise.resolve({ name, skipped: true });
  }
  const workspace = folders[0];
  // A variant of a fixture: the scenario adjusts its fresh copy before the window opens.
  if (typeof scenario.prepare === 'function') { scenario.prepare(folders); }

  const runDir = path.join(RUNS_ROOT, name);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const opened = folders.length === 1 ? workspace : path.join(runDir, 'e2e.code-workspace');
  if (folders.length > 1) { fs.writeFileSync(opened, JSON.stringify({ folders: folders.map((f) => ({ path: f })) }, null, 2)); }
  const userData = path.join(runDir, 'ud');
  const extensions = path.join(runDir, 'ext');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(extensions, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'git.enabled': false,
    'files.autoSave': 'off',
    ...(scenario.settings || {}),
    // LTR_E2E_SETTINGS='{"liveTestRunner.speedStrict":true}': settings for this run (perf A/B comparisons).
    ...(process.env.LTR_E2E_SETTINGS ? JSON.parse(process.env.LTR_E2E_SETTINGS) : {}),
  }, null, 2));

  const report = path.join(runDir, 'report.json');
  const args = [
    opened,
    `--extensionDevelopmentPath=${EXT_DIR}`,
    `--extensionTestsPath=${path.join(__dirname, 'lib', 'hostEntry.js')}`,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    '--disable-updates',
    // Linux CI containers: no setuid sandbox / GPU.
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox', '--disable-gpu'] : []),
    // LTR_E2E_DEBUG=1: debug-level logs (also inside Jest via LTR_LOG_LEVEL).
    ...(process.env.LTR_E2E_DEBUG ? ['--log', 'debug'] : []),
    // LTR_E2E_CDP_PORT: the window's DevTools port — diag-screenshots captures itself through it.
    ...(process.env.LTR_E2E_CDP_PORT ? [`--remote-debugging-port=${process.env.LTR_E2E_CDP_PORT}`] : []),
  ];

  const timeoutMs = (scenario.timeoutMs || 5 * 60_000) + 60_000;
  const started = Date.now();
  console.log(`[e2e] RUN  ${name} — workspace: ${folders.join(' + ')}`);

  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      env: childEnv({
        LTR_E2E: '1',
        LTR_E2E_SCENARIO: file,
        LTR_E2E_REPORT: report,
        LTR_E2E_WORKSPACE: workspace,
        LTR_E2E_WORKSPACES: JSON.stringify(folders),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    const timer = setTimeout(() => {
      console.log(`[e2e] TIMEOUT ${name} after ${Math.round(timeoutMs / 1000)}s — killing VS Code`);
      killLeftovers(userData, [child.pid]);
    }, timeoutMs);
    // Ctrl+C / kill of this runner: take the window and its test processes down too.
    const onSignal = (sig) => { killLeftovers(userData, [child.pid]); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    child.on('exit', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      // The launched process can exit while the window it started keeps running (or leaves its
      // test processes behind): nothing of this scenario may outlive it.
      const killed = killLeftovers(userData);
      if (killed) { console.log(`[e2e] ${name}: stopped ${killed} process(es) VS Code left running`); }
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      let result;
      try { result = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { result = undefined; }
      if (!result) {
        console.log(`[e2e] FAIL ${name} (${secs}s) — no report (VS Code exit code ${code}). Output tail:\n${out.join('').split('\n').slice(-40).join('\n')}`);
        resolve({ name, passed: false });
        return;
      }
      for (const line of result.log) { console.log(`       ${line}`); }
      for (const c of result.checks) {
        console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok || !c.detail ? '' : `\n         ${String(c.detail).split('\n').join('\n         ')}`}`);
      }
      if (result.error) { console.log(`  ERROR ${result.error}`); }
      const passed = !result.error && result.checks.every((c) => c.ok);
      if (!passed || process.env.LTR_E2E_VERBOSE) {
        console.log('  ── extension log (info+) ──');
        for (const l of result.logTail || []) { console.log(`  | ${l}`); }
        console.log('  ── raw Jest output (tail) ──');
        for (const l of result.rawTail || []) { console.log(`  > ${l}`); }
      }
      console.log(`[e2e] ${passed ? 'PASS' : 'FAIL'} ${name} (${secs}s)\n`);
      resolve({ name, passed });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const names = argv.includes('--all')
    // diag-* scenarios are investigation tools, run them by name.
    ? fs.readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.js') && !f.startsWith('diag-')).map((f) => f.slice(0, -3)).sort()
    : argv;
  if (names.length === 0) {
    console.log('Usage: node e2e/run.js <scenario…> | --all');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(EXT_DIR, 'out', 'extension.js'))) {
    console.log('Build the extension first: pnpm build');
    process.exit(2);
  }
  const exe = await resolveVscode();
  const results = [];
  for (const n of names) {
    try {
      results.push(await runScenario(n, exe));
    } catch (err) {
      // A fixture that cannot be prepared (an npm install that fails) fails its own scenario, not the rest of the run.
      console.log(`[e2e] FAIL ${n}: could not prepare it — ${String(err && err.message).split('\n')[0]}`);
      results.push({ name: n, passed: false });
    }
  }
  const failed = results.filter((r) => !r.skipped && !r.passed);
  console.log(`[e2e] ${results.length - failed.length}/${results.length} scenario(s) passed or skipped` +
    (failed.length ? ` — failed: ${failed.map((r) => r.name).join(', ')}` : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
