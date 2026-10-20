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
 * Environment:
 *   LTR_E2E_JEST_REPOS_DIR    default /Users/eshandias/Projects/test/jest-test-projects
 *   LTR_E2E_VITEST_REPOS_DIR  default /Users/eshandias/Projects/test/vitest-projects
 *   LTR_E2E_CLONES_DIR        default <tmp>/ltr real repos
 *
 * Vitest repos are listed here and picked up automatically once the
 * `repo-vitest` scenario exists (Vitest support, phase 2).
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JEST_DIR = process.env.LTR_E2E_JEST_REPOS_DIR || '/Users/eshandias/Projects/test/jest-test-projects';
const VITEST_DIR = process.env.LTR_E2E_VITEST_REPOS_DIR || '/Users/eshandias/Projects/test/vitest-projects';
const CLONES = process.env.LTR_E2E_CLONES_DIR || path.join(os.tmpdir(), 'ltr real repos');

/** name → { dir, scenario, env (the variable the scenario reads), light } */
const REPOS = {
  'jest-dom':             { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: true, baseline: 'jest' },
  'vscode-jest':          { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: true, baseline: 'jest' },
  'sample-react-project': { dir: JEST_DIR, scenario: 'repo-cra',    env: 'LTR_E2E_CRA_REPO',    light: true },
  'jest':                 { dir: JEST_DIR, scenario: 'repo-tsjest', env: 'LTR_E2E_TSJEST_REPO', light: false, baseline: 'jest' },
  'unplugin':             { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true },
  'slidev':               { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true },
  'vueuse':               { dir: VITEST_DIR, scenario: 'repo-vitest', env: 'LTR_E2E_VITEST_REPO', light: true },
};

function git(dir, ...args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); } catch { return ''; }
}

/** What identifies the repo's state: HEAD, tracked/untracked changes, and the working tree's newest mtime (excluding node_modules/.git). */
function fingerprint(dir) {
  const newest = execFileSync('find', [dir, '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', '-type', 'f', '-print'], { encoding: 'utf8', maxBuffer: 1 << 28 })
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
    const env = { [repo.env]: copy };
    if (repo.baseline === 'jest') {
      // Plain Jest on the clone is the reference the extension is compared with.
      const h = require('./lib/harness');
      const out = path.join(os.tmpdir(), `ltr-baseline-${n}.json`);
      console.log(`[repos] ${n}: plain Jest baseline…`);
      try { fs.writeFileSync(out, JSON.stringify(h.plainJestJson(copy))); env.LTR_E2E_TSJEST_BASELINE = out; }
      catch (e) { console.log(`[repos] ${n}: no baseline (${String(e.message).split('\n')[0]})`); }
    }
    console.log(`\n[repos] ===== ${n} (${repo.scenario}) =====`);
    const ok = runScenario(repo.scenario, env);
    const untouched = fingerprint(original) === before;
    if (!untouched) { console.log(`[repos] FAIL ${n}: the ORIGINAL repository changed during the run`); }
    results.push({ n, ok: ok && untouched });
  }
  console.log('\n[repos] ── summary ──');
  for (const r of results) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.n}`); }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

main();
