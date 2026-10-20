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
 *
 * Fixtures (e2e/fixtures/<name>) are copied to a temp folder whose path
 * contains spaces, and `npm install` runs there once (re-run when
 * package.json changes). Build the extension first: `pnpm build`.
 */

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'packages', 'vscode-extension');
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
  return downloadAndUnzipVSCode({ version, cachePath: path.join(ROOT, '.vscode-test') });
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

/** Fresh copy of a fixture (node_modules kept between runs). */
function prepareFixture(name) {
  const src = path.join(__dirname, 'fixtures', name);
  const dest = path.join(WORK_ROOT, `${name} project`);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(dest)) {
    if (entry !== 'node_modules') { fs.rmSync(path.join(dest, entry), { recursive: true, force: true }); }
  }
  copyDir(src, dest);

  const pkgHash = crypto.createHash('sha1').update(fs.readFileSync(path.join(src, 'package.json'))).digest('hex');
  const stamp = path.join(dest, 'node_modules', '.ltr-e2e-stamp');
  const current = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
  if (current !== pkgHash) {
    console.log(`[e2e] npm install in ${dest}`);
    execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: dest, stdio: 'inherit' });
    fs.writeFileSync(stamp, pkgHash);
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
  const workspace = resolveWorkspace(scenario.workspace);
  if (!workspace) {
    console.log(`[e2e] SKIP ${name}: workspace ${scenario.workspace} is not available`);
    return Promise.resolve({ name, skipped: true });
  }

  const runDir = path.join(RUNS_ROOT, name);
  fs.rmSync(runDir, { recursive: true, force: true });
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
  }, null, 2));

  const report = path.join(runDir, 'report.json');
  const args = [
    workspace,
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
  ];

  const timeoutMs = (scenario.timeoutMs || 5 * 60_000) + 60_000;
  const started = Date.now();
  console.log(`[e2e] RUN  ${name} — workspace: ${workspace}`);

  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      env: childEnv({
        LTR_E2E: '1',
        LTR_E2E_SCENARIO: file,
        LTR_E2E_REPORT: report,
        LTR_E2E_WORKSPACE: workspace,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    const timer = setTimeout(() => {
      console.log(`[e2e] TIMEOUT ${name} after ${Math.round(timeoutMs / 1000)}s — killing VS Code`);
      try {
        if (process.platform === 'win32') { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); }
        else { child.kill('SIGKILL'); }
      } catch { /* already gone */ }
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
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
  for (const n of names) { results.push(await runScenario(n, exe)); }
  const failed = results.filter((r) => !r.skipped && !r.passed);
  console.log(`[e2e] ${results.length - failed.length}/${results.length} scenario(s) passed or skipped` +
    (failed.length ? ` — failed: ${failed.map((r) => r.name).join(', ')}` : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
