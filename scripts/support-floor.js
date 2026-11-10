#!/usr/bin/env node
'use strict';
/**
 * Decides the oldest VS Code and Node the extension supports, from official
 * release data, and checks that the repository matches.
 *
 * Policy: a Node major is supported until BUFFER_YEARS after Node's own end of
 * life (nodejs/Release schedule). The minimum VS Code is the first release
 * whose bundled Node (its Electron's Node) is still supported. Code that runs
 * in the user's own test process (the shipped Babel parser, instrumentation)
 * must run on the oldest supported Node major.
 *
 *   node scripts/support-floor.js           report + check (offline, uses support-floor.json)
 *   node scripts/support-floor.js --check   same, quiet unless something is wrong (PR checks)
 *   node scripts/support-floor.js --update  refresh support-floor.json from the network first
 *   node scripts/support-floor.js --json    print the result as JSON (scheduled workflow)
 *   --date YYYY-MM-DD                       evaluate as of another day
 *
 * Exit 1: the repository breaks the policy (minimum above what the policy
 * allows, types or build target out of step, a shipped package that cannot
 * run on a supported Node). A minimum that may be raised is only reported.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'support-floor.json');
const BUFFER_YEARS = 2;
const FIRST_VSCODE_MINOR = 70; // history kept in the data file

const SHIPPED = require('./shipped-packages');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const dateArg = args[args.indexOf('--date') + 1];
const today = flag('--date') ? new Date(`${dateArg}T00:00:00Z`) : new Date();

// ── Versions ──────────────────────────────────────────────────────────────────

const parse = (v) => String(v).replace(/^[v=^~\s]+/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) { return x[i] - y[i]; } } return 0; };

/** Enough of semver ranges for `engines` fields: ||, comparators, ^, ~, x / *. */
function satisfies(version, range) {
  return range.split('||').some((part) => part.trim().split(/\s+/).filter(Boolean).every((c) => {
    if (c === '*' || c === 'x') { return true; }
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c);
    const op = m[1] || '';
    const raw = m[2];
    const fields = raw.split('.');
    const wild = fields.findIndex((f) => /^[x*X]$/.test(f));
    const base = parse(raw.replace(/[x*X]/g, '0'));
    const v = parse(version);
    if (!op && (wild >= 0 || fields.length < 3)) { // 18.x, 18
      const n = wild >= 0 ? wild : fields.length;
      return base.slice(0, n).every((b, i) => v[i] === b);
    }
    const d = cmp(version, base.join('.'));
    switch (op) {
      case '>=': return d >= 0;
      case '>': return d > 0;
      case '<=': return d <= 0;
      case '<': return d < 0;
      case '^': return d >= 0 && (base[0] ? v[0] === base[0] : base[1] ? v[0] === 0 && v[1] === base[1] : v[0] === 0 && v[1] === 0 && v[2] === base[2]);
      case '~': return d >= 0 && v[0] === base[0] && v[1] === base[1];
      default: return d === 0;
    }
  }));
}

const addYears = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + n); return d; };
const day = (d) => d.toISOString().slice(0, 10);

// ── Data ──────────────────────────────────────────────────────────────────────

async function get(url, json = true) {
  const headers = { 'User-Agent': 'live-test-runner-support-floor' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) { headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`; }
  const res = await fetch(url, { headers });
  if (!res.ok) { throw new Error(`${url}: HTTP ${res.status}`); }
  return json ? res.json() : res.text();
}

/** Refreshes the data file: Node's schedule, and each VS Code x.y.0 with its Electron and Node. */
async function update(old) {
  const schedule = await get('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json');
  const node = {};
  for (const [k, v] of Object.entries(schedule)) {
    const major = /^v(\d+)$/.exec(k);
    if (major && Number(major[1]) >= 12) { node[major[1]] = { start: v.start, lts: v.lts || null, end: v.end }; }
  }
  const electron = await get('https://releases.electronjs.org/releases.json');
  const electronNode = new Map(electron.map((r) => [r.version, r.node]));

  const known = new Map((old?.vscode || []).map((r) => [r.version, r]));
  const vscode = [];
  for (let page = 1; page < 10; page++) {
    const releases = await get(`https://api.github.com/repos/microsoft/vscode/releases?per_page=100&page=${page}`);
    if (!releases.length) { break; }
    let older = false;
    for (const r of releases) {
      const m = /^1\.(\d+)\.0$/.exec(r.tag_name);
      if (!m || r.draft || r.prerelease) { continue; }
      if (Number(m[1]) < FIRST_VSCODE_MINOR) { older = true; continue; }
      if (known.has(r.tag_name)) { vscode.push(known.get(r.tag_name)); continue; }
      let target;
      for (const file of ['.npmrc', '.yarnrc']) {
        const text = await get(`https://raw.githubusercontent.com/microsoft/vscode/${r.tag_name}/${file}`, false).catch(() => '');
        target = /^target\s*=?\s*"([^"]+)"/m.exec(text)?.[1];
        if (target) { break; }
      }
      if (!target || !electronNode.get(target)) { throw new Error(`VS Code ${r.tag_name}: no Electron/Node version found`); }
      vscode.push({ version: r.tag_name, released: r.published_at.slice(0, 10), electron: target, node: electronNode.get(target) });
    }
    if (older) { break; }
  }
  vscode.sort((a, b) => cmp(a.version, b.version));
  return {
    note: 'Generated by scripts/support-floor.js --update. Sources: nodejs/Release schedule.json, releases.electronjs.org, microsoft/vscode release tags.',
    updated: day(new Date()),
    node,
    vscode,
  };
}

// ── Policy ────────────────────────────────────────────────────────────────────

/** The support window on a given day: oldest supported Node major and the minimum VS Code. */
function floorOn(data, date) {
  const supported = Object.entries(data.node)
    .filter(([, v]) => addYears(v.end, BUFFER_YEARS) >= date && new Date(`${v.start}T00:00:00Z`) <= date)
    .map(([k, v]) => ({ major: Number(k), until: day(addYears(v.end, BUFFER_YEARS)) }))
    .sort((a, b) => a.major - b.major);
  const oldest = supported[0];
  const vscode = data.vscode.find((r) => parse(r.node)[0] >= oldest.major && new Date(`${r.released}T00:00:00Z`) <= date);
  return { nodeMajor: oldest.major, nodeSupportedUntil: oldest.until, vscode };
}

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const vscodeFloorOf = (range) => (/(\d+\.\d+\.\d+)/.exec(range || '') || [])[1];

function check(data, floor) {
  const errors = [];
  const notes = [];
  const rootPkg = readJson('package.json');
  const extPkg = readJson('packages/vscode-extension/package.json');
  const runnerPkg = readJson('packages/runner/package.json');

  const engines = vscodeFloorOf(extPkg.engines?.vscode);
  if (rootPkg.engines?.vscode !== extPkg.engines?.vscode) {
    errors.push(`engines.vscode differs: root ${rootPkg.engines?.vscode}, extension ${extPkg.engines?.vscode}`);
  }
  const current = data.vscode.find((r) => r.version === engines);
  if (!current) {
    errors.push(`VS Code ${engines} (engines.vscode) is not in scripts/support-floor.json — run with --update`);
    return { errors, notes, engines };
  }
  if (cmp(engines, floor.vscode.version) > 0) {
    errors.push(`engines.vscode ^${engines} drops VS Code the policy still supports: the minimum is ${floor.vscode.version} (Node ${floor.nodeMajor} supported until ${floor.nodeSupportedUntil})`);
  } else if (cmp(engines, floor.vscode.version) < 0) {
    notes.push(`the minimum can be raised: VS Code ${engines} (Node ${parse(current.node)[0]}) → ${floor.vscode.version} (Node ${parse(floor.vscode.node)[0]})`);
  }

  const hostNode = current.node;
  const hostMajor = parse(hostNode)[0];
  const typesVscode = extPkg.devDependencies?.['@types/vscode'];
  if (vscodeFloorOf(typesVscode) !== engines) {
    errors.push(`@types/vscode ${typesVscode} should be ${engines} (the minimum VS Code): newer types allow APIs that VS Code ${engines} lacks`);
  }
  for (const [name, pkg] of [['extension', extPkg], ['runner', runnerPkg]]) {
    const t = pkg.devDependencies?.['@types/node'];
    if (!t || parse(t)[0] !== hostMajor) {
      errors.push(`${name} @types/node ${t} should be ${hostMajor}.x (the Node inside VS Code ${engines})`);
    }
  }
  for (const file of ['packages/vscode-extension/esbuild.js', 'jest.esbuild.js']) {
    const target = /target:\s*'node(\d+)'/.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))?.[1];
    if (Number(target) !== hostMajor) { errors.push(`${file}: esbuild target node${target} should be node${hostMajor}`); }
  }

  // Every package the build copies or bundles must be classified above.
  const esbuildSrc = fs.readFileSync(path.join(ROOT, 'packages/vscode-extension/esbuild.js'), 'utf8');
  for (const m of esbuildSrc.matchAll(/require\.resolve\('((?:@[^/']+\/)?[^/']+)\/package\.json'\)/g)) {
    if (!SHIPPED[m[1]]) { errors.push(`${m[1]} is shipped by esbuild.js but not listed in scripts/shipped-packages.js`); }
  }
  const userNode = `${floor.nodeMajor}.0.0`;
  for (const [name, runs] of Object.entries(SHIPPED)) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`, { paths: [path.join(ROOT, 'packages/vscode-extension')] }), 'utf8')); } catch {
      errors.push(`${name}: not installed (pnpm install)`); continue;
    }
    const range = pkg.engines?.node;
    if (!range) { notes.push(`${name}@${pkg.version} declares no engines.node`); continue; }
    if (runs.includes('extension') && !satisfies(hostNode, range)) {
      errors.push(`${name}@${pkg.version} needs Node ${range}; VS Code ${engines} runs Node ${hostNode}`);
    }
    if (runs.includes('user') && !satisfies(userNode, range)) {
      errors.push(`${name}@${pkg.version} needs Node ${range}; it runs in the user's test process and Node ${floor.nodeMajor} is supported until ${floor.nodeSupportedUntil}`);
    }
    if (pkg.type === 'module') { errors.push(`${name}@${pkg.version} is an ES module; the extension loads it with require()`); }
  }
  return { errors, notes, engines, hostNode };
}

async function main() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') { throw err; } }
  if (flag('--update') || !data) {
    data = await update(data);
    fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
  }
  const floor = floorOn(data, today);
  // When the oldest supported Node leaves the window, and what the minimum becomes then.
  const nextDate = new Date(`${floor.nodeSupportedUntil}T00:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const next = floorOn(data, nextDate);
  const result = check(data, floor);

  if (flag('--json')) {
    console.log(JSON.stringify({
      date: day(today), bufferYears: BUFFER_YEARS,
      current: result.engines, minimum: floor.vscode.version, canRaise: cmp(result.engines || '0', floor.vscode.version) < 0,
      nodeMajor: floor.nodeMajor, nodeSupportedUntil: floor.nodeSupportedUntil, minimumNode: floor.vscode.node,
      next: { date: day(nextDate), minimum: next.vscode?.version, nodeMajor: next.nodeMajor },
      errors: result.errors, notes: result.notes,
    }, null, 2));
  } else if (!flag('--check') || result.errors.length) {
    console.log(`Support window on ${day(today)} (Node end of life + ${BUFFER_YEARS} years):`);
    console.log(`  oldest Node: ${floor.nodeMajor} (supported until ${floor.nodeSupportedUntil})`);
    console.log(`  minimum VS Code: ${floor.vscode.version} (${floor.vscode.released}, Electron ${floor.vscode.electron}, Node ${floor.vscode.node})`);
    console.log(`  next change: ${day(nextDate)} → VS Code ${next.vscode?.version} (Node ${next.nodeMajor})`);
    console.log(`  repository: engines.vscode ^${result.engines}`);
  }
  for (const n of result.notes) { if (!flag('--json')) { console.log(`note: ${n}`); } }
  for (const e of result.errors) { if (!flag('--json')) { console.error(`error: ${e}`); } }
  process.exitCode = result.errors.length ? 1 : 0;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
