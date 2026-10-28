#!/usr/bin/env node
'use strict';
/**
 * Real-repository regression matrix.
 *
 * Runs the extension's e2e scenarios against real open-source projects and
 * checks the results match a plain run of each project's own test runner.
 * The repositories are NEVER modified:
 *   - every repo is cloned first (APFS copy-on-write `cp -c` on macOS, `cp -a`
 *     elsewhere) and the scenarios run on the clone;
 *   - the original's `git status` and HEAD are compared before and after, and
 *     the run fails if they changed.
 *
 *   node e2e/real-repos.js                 # light Jest repos (jest-dom, vscode-jest, sample-react-project)
 *   node e2e/real-repos.js jest            # named repos (the `jest` monorepo is heavy: opt-in)
 *   node e2e/real-repos.js --all           # every repo that has a scenario
 *   node e2e/real-repos.js --fresh         # re-clone instead of reusing the clones
 *
 * Each repo's plain-runner counts per file (and whether the extension matched
 * them) are recorded in docs/temp_plans/vitest-baseline.json.
 *
 * Environment:
 *   LTR_E2E_JEST_REPOS_DIR    default /Users/eshandias/Projects/test/jest-test-projects
 *   LTR_E2E_VITEST_REPOS_DIR  default /Users/eshandias/Projects/test/vitest-projects
 *   LTR_E2E_PYTHON_REPOS_DIR  default /Users/eshandias/Projects/test/python-projects (each with its own .venv)
 *   LTR_E2E_CLONES_DIR        default <tmp>/ltr real repos
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

const ROOT = path.resolve(__dirname, '..');
const JEST_DIR = process.env.LTR_E2E_JEST_REPOS_DIR || '/Users/eshandias/Projects/test/jest-test-projects';
const VITEST_DIR = process.env.LTR_E2E_VITEST_REPOS_DIR || '/Users/eshandias/Projects/test/vitest-projects';
const PYTHON_DIR = process.env.LTR_E2E_PYTHON_REPOS_DIR || '/Users/eshandias/Projects/test/python-projects';
const CLONES = process.env.LTR_E2E_CLONES_DIR || path.join(os.tmpdir(), 'ltr real repos');

/** Per-repo plain-runner baseline, recorded on every run (see recordBaseline). */
const BASELINE_FILE = path.join(ROOT, 'docs', 'temp_plans', 'vitest-baseline.json');
const PYTEST_BASELINE_FILE = path.join(ROOT, 'docs', 'temp_plans', 'pytest-baseline.json');

/**
 * name → { dir, scenario, env (the variable the scenario reads), light,
 *          baseline (the variable the scenario reads a plain-run result from),
 *          plain ('vitest' for a plain Vitest reference; Jest otherwise) }
 */
const REPOS = {
  'jest-dom':             { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: true, baseline: 'LTR_E2E_TSJEST_BASELINE' },
  'vscode-jest':          { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: true, baseline: 'LTR_E2E_TSJEST_BASELINE' },
  'sample-react-project': { dir: JEST_DIR, scenario: 'repo-cra',    env: 'LTR_E2E_CRA_REPO',    light: true, baseline: 'LTR_E2E_CRA_BASELINE' },
  'jest':                 { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: false, baseline: 'LTR_E2E_TSJEST_BASELINE' },
  'unplugin':             { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true, baseline: 'LTR_E2E_VITEST_BASELINE', plain: 'vitest' },
  'slidev':               { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true, baseline: 'LTR_E2E_VITEST_BASELINE', plain: 'vitest' },
  'vueuse':               { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true, baseline: 'LTR_E2E_VITEST_BASELINE', plain: 'vitest' },
  // UI components (repo-components; LTR_E2E_COMPONENT_EXTS = the component files to check).
  'vue-testing-library':  { dir: JEST_DIR, scenario: 'repo-components', env: 'LTR_E2E_COMPONENT_REPO', light: true, baseline: 'LTR_E2E_COMPONENT_BASELINE', extra: { LTR_E2E_COMPONENT_EXTS: 'vue', LTR_E2E_COMPONENT_COVERAGE: '0' } }, // collectCoverageFrom: **/src/**/*.js only
  'vue-multiselect':      { dir: JEST_DIR, scenario: 'repo-components', env: 'LTR_E2E_COMPONENT_REPO', light: true, baseline: 'LTR_E2E_COMPONENT_BASELINE', extra: { LTR_E2E_COMPONENT_EXTS: 'vue' } },
  'example-app-v22':      { dir: path.join(JEST_DIR, 'jest-preset-angular', 'examples'), scenario: 'repo-components', env: 'LTR_E2E_COMPONENT_REPO', light: true, baseline: 'LTR_E2E_COMPONENT_BASELINE', extra: { LTR_E2E_COMPONENT_EXTS: 'html' } },
  'svelte-testing-library': { dir: VITEST_DIR, scenario: 'repo-components', env: 'LTR_E2E_COMPONENT_REPO', light: true, baseline: 'LTR_E2E_COMPONENT_BASELINE', plain: 'vitest', extra: { LTR_E2E_COMPONENT_EXTS: 'svelte' } },
  'click':                { dir: PYTHON_DIR, scenario: 'repo-pytest', env: 'LTR_E2E_PYTEST_REPO', light: true, baseline: 'LTR_E2E_PYTEST_BASELINE', plain: 'pytest' },
  'httpx':                { dir: PYTHON_DIR, scenario: 'repo-pytest', env: 'LTR_E2E_PYTEST_REPO', light: true, baseline: 'LTR_E2E_PYTEST_BASELINE', plain: 'pytest' },
  // pytest 7.4 (pytest<8) with pytest-cov in addopts.
  'erdantic':             { dir: PYTHON_DIR, scenario: 'repo-pytest', env: 'LTR_E2E_PYTEST_REPO', light: true, baseline: 'LTR_E2E_PYTEST_BASELINE', plain: 'pytest' },
  'pytest':               { dir: PYTHON_DIR, scenario: 'repo-pytest', env: 'LTR_E2E_PYTEST_REPO', light: false, baseline: 'LTR_E2E_PYTEST_BASELINE', plain: 'pytest' },
};

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
  if (fs.existsSync(dest)) { return; }
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
  const available = (n) => fs.existsSync(path.join(REPOS[n].dir, n)) && fs.existsSync(path.join(__dirname, 'scenarios', `${REPOS[n].scenario}.js`));
  const names = named.length ? named : Object.keys(REPOS).filter((n) => (argv.includes('--all') || REPOS[n].light));
  const results = [];
  for (const n of names) {
    const repo = REPOS[n];
    if (!repo) { console.log(`[repos] unknown repo "${n}" (known: ${Object.keys(REPOS).join(', ')})`); results.push({ n, ok: false }); continue; }
    if (!available(n)) { console.log(`[repos] SKIP ${n} (repo or scenario "${repo.scenario}" not available)`); continue; }
    const original = path.join(repo.dir, n);
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
