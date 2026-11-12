#!/usr/bin/env node
'use strict';
/**
 * Real-repository regression matrix.
 *
 * Runs the extension's e2e scenarios against real projects and checks the
 * results match a plain run of each project's own test runner. Which
 * repositories, and where they are, comes from a local config file that is
 * never committed:
 *
 *   e2e/real-repos.local.json   (or LTR_E2E_REPOS_CONFIG=<file>)
 *
 * Start from e2e/real-repos.example.json (public open-source projects). Each
 * entry: "path" (absolute, or relative to the config file's "reposDir", which
 * is itself relative to the config file), "kind" (jest | cra | vitest |
 * components | pytest), optional "runner" (components: jest | vitest),
 * "heavy" (only with --all or by name) and "env" (extra variables for the
 * scenario).
 *
 * The repositories are NEVER modified:
 *   - every repo is cloned first (APFS copy-on-write `cp -c` on macOS, `cp -a`
 *     elsewhere) and the scenarios run on the clone;
 *   - the original's `git status` and HEAD are compared before and after, and
 *     the run fails if they changed.
 *
 *   node e2e/real-repos.js                 # every repo not marked heavy
 *   node e2e/real-repos.js <name> …        # named repos (heavy ones too)
 *   node e2e/real-repos.js --all           # every repo in the config
 *   node e2e/real-repos.js --fresh         # re-clone instead of reusing the clones
 *
 * Each repo's plain-runner counts per file (and whether the extension matched
 * them) are recorded in e2e/baselines/ (local, not committed: vitest.json for
 * JS repos, pytest.json for Python ones).
 *
 * Environment: LTR_E2E_REPOS_CONFIG (the config file), LTR_E2E_CLONES_DIR
 * (default <tmp>/ltr real repos, or the config's "clonesDir").
 *
 * Vitest repos run the `repo-vitest` scenario against a plain `vitest run`
 * (with the test script's config flags) on the same clone. Python repos run
 * `repo-pytest` against a plain `python -m pytest` with the clone's .venv —
 * whose editable installs (`pip install -e .` .pth files) are pointed at the
 * clone, so the tests import the clone's code, never the original's.
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { missingPackages, missingTopFiles } = require('./lib/emptied');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.resolve(process.env.LTR_E2E_REPOS_CONFIG || path.join(__dirname, 'real-repos.local.json'));

/** Per-repo plain-runner baseline, recorded on every run (see recordBaseline); local only. */
const BASELINE_FILE = path.join(ROOT, 'e2e', 'baselines', 'vitest.json');
const PYTEST_BASELINE_FILE = path.join(ROOT, 'e2e', 'baselines', 'pytest.json');

/** What each kind of repo runs: scenario, the variables it reads, the plain-run reference. */
const KINDS = {
  jest:       { scenario: 'repo-tsjest',     env: 'LTR_E2E_TSJEST_REPO',    baseline: 'LTR_E2E_TSJEST_BASELINE' },
  cra:        { scenario: 'repo-cra',        env: 'LTR_E2E_CRA_REPO',       baseline: 'LTR_E2E_CRA_BASELINE' },
  vitest:     { scenario: 'repo-vitest',     env: 'LTR_E2E_VITEST_REPO',    baseline: 'LTR_E2E_VITEST_BASELINE', plain: 'vitest' },
  components: { scenario: 'repo-components', env: 'LTR_E2E_COMPONENT_REPO', baseline: 'LTR_E2E_COMPONENT_BASELINE' },
  pytest:     { scenario: 'repo-pytest',     env: 'LTR_E2E_PYTEST_REPO',    baseline: 'LTR_E2E_PYTEST_BASELINE', plain: 'pytest' },
};

/**
 * name → { path (absolute), scenario, env (the variable the scenario reads),
 *          light, baseline (the variable the scenario reads a plain-run
 *          result from), plain ('vitest' / 'pytest'; Jest otherwise), extra }
 */
function loadRepos() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log(`[repos] no config at ${CONFIG_FILE}\n[repos] copy e2e/real-repos.example.json to e2e/real-repos.local.json and point it at your clones (or set LTR_E2E_REPOS_CONFIG).`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const base = path.resolve(path.dirname(CONFIG_FILE), cfg.reposDir || '.');
  const repos = {};
  for (const [name, r] of Object.entries(cfg.repos || {})) {
    const kind = KINDS[r.kind];
    if (!kind) { throw new Error(`${CONFIG_FILE}: repo "${name}" has unknown kind "${r.kind}" (${Object.keys(KINDS).join(', ')})`); }
    repos[name] = {
      ...kind,
      path: path.resolve(base, r.path.replace(/^~(?=$|[\\/])/, os.homedir())),
      light: !r.heavy,
      plain: r.kind === 'components' ? (r.runner === 'vitest' ? 'vitest' : undefined) : kind.plain,
      extra: r.env || {},
    };
  }
  return { repos, clones: process.env.LTR_E2E_CLONES_DIR || (cfg.clonesDir ? path.resolve(path.dirname(CONFIG_FILE), cfg.clonesDir) : path.join(os.tmpdir(), 'ltr real repos')) };
}

function git(dir, ...args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); } catch { return ''; }
}

/** What identifies the repo's state: HEAD, tracked/untracked changes, and the working tree's newest mtime (excluding node_modules/.git). */
function fingerprint(dir) {
  const newest = execFileSync('find', [dir, '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.venv', ')', '-prune', '-o', '-type', 'f', '-print'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(Boolean)
    .reduce((m, f) => { try { return Math.max(m, fs.statSync(f).mtimeMs); } catch { return m; } }, 0);
  return JSON.stringify({ head: git(dir, 'rev-parse', 'HEAD').trim(), status: git(dir, 'status', '--porcelain'), newest });
}

function clone(src, dest, fresh) {
  if (fresh) { fs.rmSync(dest, { recursive: true, force: true }); }
  if (fs.existsSync(dest)) {
    // A clone in the temp folder that macOS emptied (lib/emptied.js): clone it again.
    const gone = [...missingTopFiles(src, dest), ...missingPackages(dest)];
    if (gone.length === 0) { return; }
    console.log(`[repos] ${dest} lost ${gone.length} file(s) or package(s) (${gone.slice(0, 3).join(', ')}…) — cloning again`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`[repos] cloning ${src} → ${dest}`);
  const args = process.platform === 'darwin' ? ['-cR', src, dest] : ['-a', src, dest];
  const r = spawnSync('cp', args, { stdio: 'inherit' });
  if (r.status !== 0) { throw new Error(`clone failed (cp exit ${r.status})`); }
  repointEditableInstalls(src, dest);
  dropBytecodeCaches(dest);
}

/**
 * Python bytecode copied from the original names the original's files
 * (pytest reuses its cached .pyc by mtime and size, not by path): test
 * locations would point at the original. The clone recompiles instead.
 */
function dropBytecodeCaches(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.venv' || entry.name === 'node_modules' || entry.name === '.git') { continue; }
    const p = path.join(dir, entry.name);
    if (entry.name === '__pycache__') { fs.rmSync(p, { recursive: true, force: true }); } else { dropBytecodeCaches(p); }
  }
}

/** The clone's .venv: editable-install .pth files name the original folder — point them at the clone. */
function repointEditableInstalls(src, dest) {
  const lib = path.join(dest, '.venv', process.platform === 'win32' ? 'Lib' : 'lib');
  if (!fs.existsSync(lib)) { return; }
  const dirs = process.platform === 'win32' ? [path.join(lib, 'site-packages')]
    : fs.readdirSync(lib).filter((d) => d.startsWith('python')).map((d) => path.join(lib, d, 'site-packages'));
  for (const dir of dirs) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.pth') && !/^__editable__.*finder\.py$/.test(f)) { continue; }
      const p = path.join(dir, f);
      const text = fs.readFileSync(p, 'utf8');
      if (text.includes(src)) { fs.writeFileSync(p, text.split(src).join(dest)); }
    }
  }
}

/** A plain pytest result (plainPytestResults) as JSON-able per-file test outcomes. */
function pytestResultsJson(results) {
  return Object.fromEntries([...results].map(([file, tests]) => [file, Object.fromEntries(tests)]));
}

/** Per-file plain pytest counts of a Python repo, recorded like the Vitest baseline. */
function recordPytestBaseline(name, original, copy, json, ok) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(PYTEST_BASELINE_FILE, 'utf8')); } catch { /* first run */ }
  const files = {};
  for (const [file, tests] of Object.entries(json).sort(([a], [b]) => a.localeCompare(b))) {
    const c = { passed: 0, failed: 0, skipped: 0 };
    for (const s of Object.values(tests)) { c[s] = (c[s] || 0) + 1; }
    files[path.relative(copy, file).split(path.sep).join('/')] = c;
  }
  const total = Object.values(files).reduce((t, c) => ({ passed: t.passed + c.passed, failed: t.failed + c.failed, skipped: t.skipped + c.skipped }), { passed: 0, failed: 0, skipped: 0 });
  all[name] = { recorded: new Date().toISOString(), head: git(original, 'rev-parse', 'HEAD').trim(), extensionMatches: ok, files: Object.keys(files).length, total, perFile: files };
  fs.writeFileSync(PYTEST_BASELINE_FILE, JSON.stringify(all, null, 2) + '\n');
}

/**
 * Writes the repo's plain-runner per-file counts (paths relative to the repo)
 * and whether the extension matched them into BASELINE_FILE, keeping the
 * other repos' entries.
 */
function recordBaseline(name, original, copy, json, ok) {
  const h = require('./lib/harness');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { /* first run */ }
  const files = {};
  const counts = [...h.jestJsonCounts(json, copy)].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, c] of counts) { files[path.relative(copy, file).split(path.sep).join('/')] = c; }
  const total = Object.values(files).reduce((t, c) => ({ passed: t.passed + c.passed, failed: t.failed + c.failed, skipped: t.skipped + c.skipped }), { passed: 0, failed: 0, skipped: 0 });
  all[name] = { recorded: new Date().toISOString(), head: git(original, 'rev-parse', 'HEAD').trim(), extensionMatches: ok, files: Object.keys(files).length, total, perFile: files };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(all, null, 2) + '\n');
}

function runScenario(name, env) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), name], { stdio: 'inherit', env: { ...process.env, ...env }, cwd: ROOT });
  return r.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const named = argv.filter((a) => !a.startsWith('--'));
  const { repos: REPOS, clones: CLONES } = loadRepos();
  const available = (n) => fs.existsSync(REPOS[n].path) && fs.existsSync(path.join(__dirname, 'scenarios', `${REPOS[n].scenario}.js`));
  const names = named.length ? named : Object.keys(REPOS).filter((n) => (argv.includes('--all') || REPOS[n].light));
  const results = [];
  for (const n of names) {
    const repo = REPOS[n];
    if (!repo) { console.log(`[repos] unknown repo "${n}" (known: ${Object.keys(REPOS).join(', ')})`); results.push({ n, ok: false }); continue; }
    if (!available(n)) { console.log(`[repos] SKIP ${n} (repo or scenario "${repo.scenario}" not available)`); continue; }
    const original = repo.path;
    const copy = path.join(CLONES, n);
    const before = fingerprint(original);
    clone(original, copy, fresh);
    const env = { [repo.env]: copy, ...(repo.extra || {}) };
    let baseline;
    if (repo.baseline) {
      // A plain run of the project's own runner on the clone is the reference the extension is compared with.
      const h = require('./lib/harness');
      const out = path.join(os.tmpdir(), `ltr-baseline-${n}.json`);
      const vitest = repo.plain === 'vitest';
      const pytest = repo.plain === 'pytest';
      console.log(`[repos] ${n}: plain ${vitest ? 'Vitest' : pytest ? 'pytest' : 'Jest'} baseline…`);
      try {
        baseline = vitest ? h.plainVitestJson(copy) : pytest ? pytestResultsJson(h.plainPytestResults(copy)) : h.plainJestJson(copy);
        fs.writeFileSync(out, JSON.stringify(baseline));
        env[repo.baseline] = out;
      }
      catch (e) { console.log(`[repos] ${n}: no baseline (${String(e.message).split('\n')[0]})`); }
    }
    console.log(`\n[repos] ===== ${n} (${repo.scenario}) =====`);
    const ok = runScenario(repo.scenario, env);
    const untouched = fingerprint(original) === before;
    if (!untouched) { console.log(`[repos] FAIL ${n}: the ORIGINAL repository changed during the run`); }
    if (baseline) { (repo.plain === 'pytest' ? recordPytestBaseline : recordBaseline)(n, original, copy, baseline, ok); }
    results.push({ n, ok: ok && untouched });
  }
  console.log('\n[repos] ── summary ──');
  for (const r of results) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.n}`); }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

main();
