#!/usr/bin/env node
'use strict';
/**
 * Measures the extension on a large Jest project and a plain Jest run of the
 * same project, with the same number of processes the extension uses.
 * The before/after check for performance work. Build first: `pnpm build`.
 *
 *   node scripts/perf-measure.js <project> [--label <name>] [--open <test file>]
 *                                [--no-plain] [--no-save] [--in-place]
 *
 *   --label     name the numbers are stored under (default: the folder name)
 *   --open      test file opened before Start, relative to the project
 *   --no-plain  skip the plain Jest run
 *   --no-save   skip the source-save rerun
 *   --in-place  run on the project itself (only for generated projects,
 *               scripts/perf-project.js); otherwise an APFS / `cp -a` copy in
 *               <tmp>/ltr perf is used, so the project is never modified
 *
 * Results are added to e2e/baselines/perf.json (local, not committed) and
 * printed as a table. The extension side is the diag-perf e2e scenario.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'e2e', 'baselines', 'perf.json');

function parseArgs(argv) {
  const opts = { project: undefined, label: undefined, open: undefined, plain: true, save: true, inPlace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') { opts.label = argv[++i]; }
    else if (a === '--open') { opts.open = argv[++i]; }
    else if (a === '--no-plain') { opts.plain = false; }
    else if (a === '--no-save') { opts.save = false; }
    else if (a === '--in-place') { opts.inPlace = true; }
    else if (!a.startsWith('--')) { opts.project = path.resolve(a); }
  }
  if (!opts.project || !fs.existsSync(opts.project)) {
    console.log('Usage: node scripts/perf-measure.js <project> [--label name] [--open file] [--no-plain] [--no-save] [--in-place]');
    process.exit(2);
  }
  opts.label = opts.label || path.basename(opts.project);
  return opts;
}

function workCopy(src, label) {
  const dest = path.join(os.tmpdir(), 'ltr perf', label);
  if (fs.existsSync(dest)) { return dest; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`[perf] copying ${src} → ${dest}`);
  const r = spawnSync('cp', process.platform === 'darwin' ? ['-cR', src, dest] : ['-a', src, dest], { stdio: 'inherit' });
  if (r.status !== 0) { throw new Error(`copy failed (cp exit ${r.status})`); }
  return dest;
}

/** Processes the extension runs at once on this machine (the runner's budget). */
function extensionProcesses() {
  const { parallelBatches } = require(path.join(ROOT, 'packages', 'runner', 'dist', 'utils', 'resources.js'));
  return parallelBatches();
}

function plainJest(dir) {
  const bin = path.join(dir, 'node_modules', 'jest', 'bin', 'jest.js');
  if (!fs.existsSync(bin)) { throw new Error(`no Jest in ${dir}/node_modules`); }
  const out = path.join(os.tmpdir(), `ltr-perf-plain-${process.pid}.json`);
  const workers = extensionProcesses();
  console.log(`[perf] plain Jest, --maxWorkers=${workers}…`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [bin, '--maxWorkers=' + workers, '--json', '--outputFile', out], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 30 });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  let json;
  try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { json = undefined; }
  fs.rmSync(out, { force: true });
  if (!json) { console.log(`[perf] plain Jest wrote no results (exit ${r.status})`); return { seconds, workers }; }
  return { seconds, workers, files: json.numTotalTestSuites, passed: json.numPassedTests, failed: json.numFailedTests, skipped: json.numPendingTests + (json.numTodoTests || 0) };
}

function extensionRun(dir, opts) {
  const out = path.join(os.tmpdir(), `ltr-perf-ext-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const env = { ...process.env, LTR_E2E_PERF_REPO: dir, LTR_E2E_PERF_OUT: out };
  if (opts.open) { env.LTR_E2E_PERF_OPEN = opts.open; }
  if (!opts.save) { env.LTR_E2E_PERF_SAVE = '0'; }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'e2e', 'run.js'), 'diag-perf'], { cwd: ROOT, stdio: 'inherit', env });
  let json;
  try { json = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { json = undefined; }
  fs.rmSync(out, { force: true });
  return { ok: r.status === 0, ...(json || {}) };
}

function printTable(label, plain, ext) {
  const row = (k, v) => console.log(`  ${k.padEnd(34)} ${v ?? '—'}`);
  console.log(`\n[perf] ── ${label} ──`);
  row('test files', ext.testFiles);
  row('discovery cold / warm (s)', `${ext.discoveryCold?.seconds ?? '—'} / ${ext.discoveryWarm?.seconds ?? '—'}`);
  row('first result, open file (s)', ext.firstResultOpenFileS);
  row('full run, extension (s)', ext.fullRunS);
  row('full run, plain Jest (s)', plain && `${plain.seconds} (--maxWorkers=${plain.workers})`);
  row('trace parse: total ms / KB / max ms', ext.trace && `${ext.trace.ms} / ${ext.trace.kb} / ${ext.trace.maxMs}`);
  row('coverage parse: total ms / KB / max', ext.coverage && `${ext.coverage.ms} / ${ext.coverage.kb} / ${ext.coverage.maxMs}`);
  row('batches: count / max s', ext.batches && `${ext.batches.count} / ${ext.batches.maxS}`);
  row('test processes peak RSS (MB)', ext.testProcessesPeakRssMb);
  row('extension host RSS / heap (MB)', ext.extensionHost && `${ext.extensionHost.rssMb} / ${ext.extensionHost.heapUsedMb} (+${ext.extensionHost.heapGrowthMb})`);
  row('trace store: source files / KB', ext.traceStore && `${ext.traceStore.sourceFiles} / ${ext.traceStore.dumpKb}`);
  row('save rerun (s, path, test files)', ext.save && `${ext.save.seconds} (${ext.save.path}, ${ext.save.testFiles})`);
  row('results ext / plain (pass, fail)', `${ext.summary?.passed}, ${ext.summary?.failed} / ${plain ? `${plain.passed}, ${plain.failed}` : '—'}`);
  row('fallbacks to plain runs', ext.fallbacks);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.inPlace ? opts.project : workCopy(opts.project, opts.label);
  const plain = opts.plain ? plainJest(dir) : undefined;
  const ext = extensionRun(dir, opts);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch { /* first run */ }
  (all[opts.label] = all[opts.label] || []).push({ plain, extension: ext });
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2) + '\n');
  printTable(opts.label, plain, ext);
  process.exit(ext.ok ? 0 : 1);
}

main();
