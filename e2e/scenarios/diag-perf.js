'use strict';
/**
 * Performance measurement on a large project (run by name; scripts/perf-measure.js
 * runs it and prints the numbers next to a plain run).
 *
 *   LTR_E2E_PERF_REPO   the project (a clone: a source file is saved and restored)
 *   LTR_E2E_PERF_OPEN   test file to open before Start, relative to the project
 *                       (default: the first test file in the tree)
 *   LTR_E2E_PERF_OUT    JSON file the numbers are written to
 *   LTR_E2E_PERF_SAVE   0 = skip the source-save rerun
 *   LTR_E2E_PERF_LOG    file the whole extension log of the run is written to (for a closer look)
 *   LTR_E2E_PERF_PROFILE  .cpuprofile file: a CPU profile of the extension host during the full run
 *                       (open it in Chrome DevTools or VS Code)
 *
 * Records: discovery (cold, then warm from the cache), time to the open file's
 * first result, time to the end of the full run, time and size of the trace
 * and coverage parsing in the extension, peak memory of the test processes and
 * of the extension host, the trace store's size, and one source-save rerun.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const h = require('../lib/harness');

/** Collects every extension log line (the logger keeps only the last 1000). */
function logCollector(api) {
  const seen = new Set();
  const lines = [];
  const take = () => { for (const l of api.logger.recentLines()) { if (!seen.has(l)) { seen.add(l); lines.push(l); } } };
  const timer = setInterval(take, 500);
  return { lines, stop() { clearInterval(timer); take(); } };
}

/** Peak summed RSS (MB) of the processes whose command line names the project, sampled every second. */
function rssSampler(marker) {
  let peak = 0;
  // Asynchronous: a synchronous ps blocked the extension host it measures (~10% of a run).
  const sample = () => execFile('ps', ['-A', '-ww', '-o', 'rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
    if (err) { return; }
    let kb = 0;
    for (const l of out.split('\n')) {
      if (!l.includes(marker) || !/node|python/.test(l)) { continue; }
      kb += Number(l.trim().split(/\s+/)[0]) || 0;
    }
    peak = Math.max(peak, kb / 1024);
  });
  const timer = setInterval(sample, 1000);
  return { stop() { clearInterval(timer); return Math.round(peak); } };
}

/** CPU profile of this process (the extension host) through Node's inspector; stop() writes it. */
function cpuProfiler(file) {
  if (!file) { return { async stop() {} }; }
  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));
  const started = post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 1000 })).then(() => post('Profiler.start'));
  return {
    async stop() {
      await started;
      const { profile } = await post('Profiler.stop');
      fs.writeFileSync(file, JSON.stringify(profile));
      session.disconnect();
    },
  };
}

/** Average summed CPU % of the test VS Code's own processes (renderer, extension host, …), sampled every 2 s. */
function cpuSampler() {
  let sum = 0;
  let n = 0;
  const sample = () => execFile('ps', ['-A', '-ww', '-o', '%cpu=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
    if (err) { return; }
    let pct = 0;
    for (const l of out.split('\n')) {
      if (/\.vscode-test[\\/]/.test(l) && !/node_modules/.test(l)) { pct += Number(l.trim().split(/\s+/)[0]) || 0; }
    }
    sum += pct;
    n++;
  });
  const timer = setInterval(sample, 2000);
  return { stop() { clearInterval(timer); return n ? Math.round(sum / n) : null; } };
}

const secs = (ms) => Math.round(ms / 100) / 10;

/** Sums the parse times (and sizes, where logged) of the matching lines. */
function sumMatches(lines, re) {
  const out = { count: 0, kb: 0, ms: 0, maxMs: 0 };
  for (const l of lines) {
    if (!re.test(l)) { continue; }
    const ms = /(\d+) ms\)\s*$/.exec(l);
    if (!ms) { continue; }
    const kb = /(\d+) KB/.exec(l);
    out.count++;
    out.kb += kb ? Number(kb[1]) : 0;
    out.ms += Number(ms[1]);
    out.maxMs = Math.max(out.maxMs, Number(ms[1]));
  }
  return out;
}

function discoverySeconds(lines) {
  const l = [...lines].reverse().find((x) => /Discovered \d+ test\(s\)/.test(x));
  const m = l && / in ([\d.]+)s \((.*)\)$/.exec(l);
  return m ? { seconds: Number(m[1]), detail: m[2] } : undefined;
}

module.exports = {
  workspace: 'env:LTR_E2E_PERF_REPO',
  timeoutMs: 120 * 60_000,

  async run({ api, t, vscode, workspace }) {
    const logs = logCollector(api);
    const result = { workspace: path.basename(workspace), at: new Date().toISOString(), cores: require('os').cpus().length };

    // Discovery: cold (at activation, empty cache), then warm (the cache).
    await h.waitForDiscovery(api);
    result.testFiles = api.store.getAllFiles().length;
    result.discoveryCold = discoverySeconds(logs.lines.concat(api.logger.recentLines()));
    api.discovery.restart();
    await h.sleep(200);
    await h.waitFor(() => api.discovery.hasCompleted && !api.discovery.isDiscovering, { what: 'warm discovery', timeout: 600_000 });
    await h.sleep(600);
    result.discoveryWarm = discoverySeconds(api.logger.recentLines());
    t.info(`discovery: cold ${JSON.stringify(result.discoveryCold)}, warm ${JSON.stringify(result.discoveryWarm)}`);

    // Open one test file, then Start.
    const files = api.store.getAllFiles().map((f) => f.filePath).sort();
    const open = process.env.LTR_E2E_PERF_OPEN ? path.join(workspace, process.env.LTR_E2E_PERF_OPEN) : files[0];
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(open)));
    result.openFile = path.relative(workspace, open);

    const rec = h.recordEvents(api);
    const rss = rssSampler(workspace);
    const cpu = cpuSampler();
    const profiler = cpuProfiler(process.env.LTR_E2E_PERF_PROFILE);
    const cpuBefore = process.cpuUsage();
    const heapBefore = process.memoryUsage();
    const startedAt = Date.now();
    const since = h.isoNow();
    await vscode.commands.executeCommand('liveTestRunner.startTesting');
    await h.waitFor(() => api.session._activeRuns === 0, { what: 'full run', timeout: 110 * 60_000 });
    const fullMs = Date.now() - startedAt;
    result.testProcessesPeakRssMb = rss.stop();
    result.vscodeAvgCpuPct = cpu.stop();
    await profiler.stop();
    const cpuUsed = process.cpuUsage(cpuBefore);
    const heapAfter = process.memoryUsage();

    const firstOpen = rec.of('file-result').find((e) => e.file === path.basename(open));
    const firstAny = rec.of('file-result')[0];
    result.firstResultOpenFileS = firstOpen ? secs(firstOpen.at - startedAt) : null;
    result.firstResultAnyS = firstAny ? secs(firstAny.at - startedAt) : null;
    result.fullRunS = secs(fullMs);
    result.summary = api.store.getSummary();
    if (!firstAny) { t.info(`no result at all — last log lines:\n${api.logger.recentLines().slice(-40).join('\n')}`); }
    t.info(`first result (open file) ${result.firstResultOpenFileS}s, full run ${result.fullRunS}s, summary ${JSON.stringify(result.summary)}`);

    logs.stop();
    if (process.env.LTR_E2E_PERF_LOG) { fs.writeFileSync(process.env.LTR_E2E_PERF_LOG, logs.lines.join('\n') + '\n'); }
    const runLogs = logs.lines.filter((l) => l.slice(0, 24) >= since);
    // Every framework's batch runner logs both with the parse time last: "… (… ms)".
    result.trace = sumMatches(runLogs, /: (traced|covering tests —) \d+ test\(s\) across/);
    result.coverage = sumMatches(runLogs, /: coverage — |file\(s\) measured, .* worker record\(s\)/);
    const batchTimes = runLogs.map((l) => /: done in ([\d.]+)s/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
    result.batches = { count: batchTimes.length, sumS: Math.round(batchTimes.reduce((a, b) => a + b, 0)), maxS: Math.max(0, ...batchTimes) };
    result.fallbacks = runLogs.filter((l) => /falling back to|retrying it with plain/.test(l)).length;
    const dump = api.traceStore.dump();
    result.traceStore = {
      sourceFiles: dump.split('\n').filter((l) => l.startsWith('  [source]')).length,
      dumpKb: Math.round(dump.length / 1024),
    };
    result.extensionHost = {
      rssMb: Math.round(heapAfter.rss / 1048576),
      heapUsedMb: Math.round(heapAfter.heapUsed / 1048576),
      heapGrowthMb: Math.round((heapAfter.heapUsed - heapBefore.heapUsed) / 1048576),
      cpuS: Math.round((cpuUsed.user + cpuUsed.system) / 1e5) / 10,
    };
    t.info(`trace parse ${JSON.stringify(result.trace)}, coverage parse ${JSON.stringify(result.coverage)}, batches ${JSON.stringify(result.batches)}`);
    t.info(`trace store ${JSON.stringify(result.traceStore)}, extension host ${JSON.stringify(result.extensionHost)}, test processes peak ${result.testProcessesPeakRssMb} MB`);
    t.eq('no test left running', h.nodesWithStatus(api, 'running').length, 0);
    rec.stop();

    // One source save: which path was taken, and how long it took.
    if (process.env.LTR_E2E_PERF_SAVE !== '0') {
      const mapped = dump.split('\n').filter((l) => l.startsWith('  [source]')).map((l) => l.slice(11).trim())
        .filter((f) => /\.([jt]sx?|py)$/.test(f) && !/[\\/](node_modules|\.venv|site-packages)[\\/]/.test(f))
        .map((f) => ({ f, n: api.traceStore.getAffectedTestFiles(f).length }))
        .filter((x) => x.n >= 1 && x.n <= 5)
        .sort((a, b) => b.n - a.n);
      const src = mapped[0]?.f;
      if (src) {
        const original = fs.readFileSync(src, 'utf8');
        try {
          const s2 = h.isoNow();
          const t0 = Date.now();
          await h.editAndSave(vscode, src, (s) => s + '\n// ltr-perf touch\n');
          await h.sleep(800);
          await h.waitFor(() => api.session._activeRuns === 0, { what: 'save rerun', timeout: 600_000 });
          const l2 = h.logsSince(api, s2);
          result.save = {
            file: path.relative(workspace, src),
            testFiles: mapped[0].n,
            seconds: secs(Date.now() - t0),
            path: l2.some((l) => /Trace-based rerun/.test(l)) ? 'trace' : l2.some((l) => /related/i.test(l)) ? 'related' : 'other',
          };
          t.info(`save rerun ${JSON.stringify(result.save)}`);
        } finally {
          await h.editAndSave(vscode, src, () => original);
          await h.sleep(800);
          await h.waitFor(() => api.session._activeRuns === 0, { what: 'restore rerun', timeout: 600_000 });
          t.check(`${path.basename(src)} restored byte-for-byte`, fs.readFileSync(src, 'utf8') === original);
        }
      }
    }

    await vscode.commands.executeCommand('liveTestRunner.stopTesting');
    if (process.env.LTR_E2E_PERF_OUT) { fs.writeFileSync(process.env.LTR_E2E_PERF_OUT, JSON.stringify(result, null, 2) + '\n'); }
    t.info(`numbers: ${JSON.stringify(result)}`);
  },
};
