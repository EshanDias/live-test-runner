import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Executor } from '../execution/Executor';
import { resolvePackageDir } from '../resolution/BinaryResolver';
import { toSpawnPath } from '../resolution/RunnerPaths';
import { createLogger } from '../utils/logger';
import { workerCount } from '../utils/resources';

const log = createLogger('VitestProjects');

/** One project of a Vitest config (`test.projects`). */
export interface VitestProjectInfo {
  /** `test.name`; '' for a config without projects. */
  name: string;
  /** Browser mode (Playwright / WebdriverIO) — needs a real browser to run. */
  browser: boolean;
}

/**
 * Lists the projects with the project's own Vitest (its node API resolves the
 * config — functions, `extends`, globs — exactly as a run would) and prints
 * them on one line. Vitest 1 and 2 use `workspace` files instead of
 * `test.projects`; they report a single project, which is fine for the guard.
 */
const PROBE = `import { pathToFileURL } from 'node:url';
const [nodeEntry, config] = process.argv.slice(2);
const { createVitest } = await import(pathToFileURL(nodeEntry).href);
const vitest = await createVitest('test', { watch: false, run: true, ...(config ? { config } : {}) }, {}, {});
const projects = (vitest.projects || []).map((p) => ({
  name: typeof p.getName === 'function' ? p.getName() : (p.name || ''),
  browser: !!(p.config && p.config.browser && p.config.browser.enabled),
}));
const coverage = vitest.config && vitest.config.coverage;
process.stdout.write('\\nLTR_PROJECTS ' + JSON.stringify(projects) + '\\n');
const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined;
process.stdout.write('LTR_COVERAGE ' + JSON.stringify({
  provider: (coverage && coverage.provider) || 'v8',
  include: strings(coverage && coverage.include),
  exclude: strings(coverage && coverage.exclude),
  all: coverage && typeof coverage.all === 'boolean' ? coverage.all : undefined,
  root: vitest.config && vitest.config.root,
}) + '\\n');
const vc = vitest.config || {};
const pool = vc.poolOptions || {};
const poolMax = [pool.threads && pool.threads.maxThreads, pool.forks && pool.forks.maxForks, pool.vmThreads && pool.vmThreads.maxThreads, pool.vmForks && pool.vmForks.maxForks];
process.stdout.write('LTR_WORKERS ' + JSON.stringify({
  max: vc.fileParallelism === false ? 1 : (vc.maxWorkers ?? null),
  pool: poolMax.filter((v) => v !== undefined && v !== null),
}) + '\\n');
await vitest.close();
process.exit(0);
`;

/** What the probe read from the resolved config. */
export interface VitestConfigInfo {
  projects: VitestProjectInfo[];
  /** `coverage.provider`: 'v8' (Vitest's default), 'istanbul' or 'custom'. */
  coverageProvider: string;
  /**
   * Which files count toward coverage (`coverage.include` / `exclude`, Vitest's
   * defaults merged in, relative to `root`; `all` below Vitest 4 only).
   * Undefined when the probe could not report them.
   */
  coverage?: { root: string; include?: string[]; exclude?: string[]; all?: boolean };
  /**
   * The lowest worker limit the config sets (`maxWorkers`, a pool's
   * `maxThreads` / `maxForks`, 1 for `fileParallelism: false`) as a count.
   * Undefined when it sets none.
   */
  maxWorkers?: number;
}

const cache = new Map<string, { stamp: string; info: Promise<VitestConfigInfo | undefined> }>();

/**
 * The projects of the Vitest config in `projectRoot` (undefined when they
 * cannot be read — callers then apply no project filter). Cached until the
 * config file or package.json changes.
 */
export async function vitestProjects(
  projectRoot: string,
  configPath: string | undefined,
  tmpDir: string,
  logger?: (msg: string) => void,
): Promise<VitestProjectInfo[] | undefined> {
  return (await vitestConfigInfo(projectRoot, configPath, tmpDir, logger))?.projects;
}

/**
 * Where a project's probe answer is remembered between sessions (off until
 * the extension names a folder; unit tests leave it off).
 */
let storeDir: string | undefined;
/** Remember probe answers in `dir` across sessions (undefined: in memory only). */
export function rememberVitestConfigIn(dir: string | undefined): void {
  storeDir = dir;
}

/** The file a project's remembered probe answer lives in (cleared and pruned with the other caches). */
export function vitestConfigCachePath(projectRoot: string, dir: string): string {
  const id = crypto.createHash('sha256').update(path.normalize(projectRoot)).digest('hex').slice(0, 16);
  return path.join(dir, `vitest-config-${id}.json`);
}

function readStored(projectRoot: string, stamp: string): VitestConfigInfo | undefined {
  if (!storeDir) { return undefined; }
  try {
    const file = vitestConfigCachePath(projectRoot, storeDir);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { stamp?: string; info?: VitestConfigInfo };
    if (data.stamp !== stamp || !data.info || !Array.isArray(data.info.projects)) { return undefined; }
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { /* in use: kept by the 30-day pruning */ }
    return data.info;
  } catch {
    return undefined;
  }
}

function store(projectRoot: string, stamp: string, info: VitestConfigInfo | undefined): void {
  if (!storeDir) { return; }
  const file = vitestConfigCachePath(projectRoot, storeDir);
  try {
    if (!info) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ stamp, info }), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    log.debug(`Could not remember the Vitest config of ${projectRoot}: ${(err as Error).message}`);
  }
}

/**
 * Projects and coverage provider of the resolved config (one probe, cached
 * like vitestProjects). The last session's answer, when its config files are
 * unchanged, is used at once and checked by a probe in the background: Start
 * waited ~1.2 s for the probe before the first test ran. A config can import
 * files the stamp does not see, so a different answer replaces it for the
 * rest of the session.
 */
export function vitestConfigInfo(
  projectRoot: string,
  configPath: string | undefined,
  tmpDir: string,
  logger?: (msg: string) => void,
): Promise<VitestConfigInfo | undefined> {
  const stamp = [configPath ?? '', mtime(configPath), mtime(path.join(projectRoot, 'package.json')), vitestVersionStamp(projectRoot)].join('|');
  const hit = cache.get(projectRoot);
  if (hit && hit.stamp === stamp) { return hit.info; }
  const remembered = readStored(projectRoot, stamp);
  const probed = runProbe(projectRoot, configPath, tmpDir, logger);
  if (remembered) {
    log.debug(`Vitest config of ${projectRoot}: the last session's answer (config unchanged), checking it in the background`);
    cache.set(projectRoot, { stamp, info: Promise.resolve(remembered) });
    void probed.then((fresh) => {
      if (!fresh) { return; } // probe failed: keep what worked last time
      store(projectRoot, stamp, fresh);
      if (!sameConfigInfo(fresh, remembered)) {
        log.info(`The Vitest config of ${projectRoot} changed since the last session (a file it imports?) — later runs use the new settings`);
        const now = cache.get(projectRoot);
        if (now && now.stamp === stamp) { cache.set(projectRoot, { stamp, info: Promise.resolve(fresh) }); }
      }
    });
    return Promise.resolve(remembered);
  }
  void probed.then((fresh) => store(projectRoot, stamp, fresh));
  cache.set(projectRoot, { stamp, info: probed });
  return probed;
}

/**
 * Whether two probe answers mean the same. The coverage globs are a set:
 * a config with several projects lists them in a different order each time (vueuse).
 */
export function sameConfigInfo(a: VitestConfigInfo, b: VitestConfigInfo): boolean {
  const canon = (i: VitestConfigInfo) => JSON.stringify({
    ...i,
    coverage: i.coverage && { ...i.coverage, include: i.coverage.include && [...i.coverage.include].sort(), exclude: i.coverage.exclude && [...i.coverage.exclude].sort() },
  });
  return canon(a) === canon(b);
}

/** The installed Vitest's package.json (an upgrade changes what the probe reports). */
function vitestVersionStamp(projectRoot: string): string {
  const dir = resolvePackageDir('vitest', projectRoot);
  return dir ? mtime(path.join(dir, 'package.json')) : '-';
}

/**
 * Whether Vitest can measure coverage here: the configured provider's
 * package (`@vitest/coverage-v8` / `-istanbul`) is installed. A custom
 * provider is assumed to be set up.
 */
export function vitestCoverageInstalled(projectRoot: string, provider: string): boolean {
  if (provider !== 'v8' && provider !== 'istanbul') { return true; }
  return !!resolvePackageDir(`@vitest/coverage-${provider}`, projectRoot);
}

/** For tests only. */
export function _resetVitestProjects(): void {
  cache.clear();
}

/** How the config is probed; replaceable in unit tests. */
let runProbe: typeof probe = (...args) => probe(...args);
/** For tests only: replace (or with no argument, restore) the probe. */
export function _setVitestProbe(fn?: typeof probe): void {
  runProbe = fn ?? ((...args) => probe(...args));
}

async function probe(
  projectRoot: string,
  configPath: string | undefined,
  tmpDir: string,
  logger?: (msg: string) => void,
): Promise<VitestConfigInfo | undefined> {
  const nodeEntry = vitestNodeEntry(projectRoot);
  if (!nodeEntry) {
    log.debug(`No vitest/node entry under ${projectRoot} — not reading its projects`);
    return undefined;
  }
  // A private folder of its own (mkdtemp: unpredictable name, owner-only), removed after the probe.
  let probeDir: string;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    probeDir = fs.mkdtempSync(path.join(tmpDir, 'ltr-vitest-probe-'));
    fs.writeFileSync(path.join(probeDir, 'probe.mjs'), PROBE, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    log.warn(`Could not write the Vitest project probe to ${tmpDir}`, err);
    return undefined;
  }
  const startedAt = Date.now();
  let result: Awaited<ReturnType<Executor['run']>>;
  try {
    result = await new Executor(logger).run({
      binary: path.join(probeDir, 'probe.mjs'),
      // One spelling, like the runs (see toSpawnPath).
      args: [toSpawnPath(nodeEntry), configPath ? toSpawnPath(configPath) : ''],
      cwd: toSpawnPath(projectRoot),
      timeoutMs: 60_000,
      label: 'vitest',
    });
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const line = result.stdout.split('\n').find((l) => l.startsWith('LTR_PROJECTS '));
  if (!line) {
    log.warn(`Could not read the Vitest projects of ${projectRoot} — running without a project filter`);
    return undefined;
  }
  try {
    const projects = JSON.parse(line.slice('LTR_PROJECTS '.length)) as VitestProjectInfo[];
    const covLine = result.stdout.split('\n').find((l) => l.startsWith('LTR_COVERAGE '));
    const cov = covLine
      ? JSON.parse(covLine.slice('LTR_COVERAGE '.length)) as { provider: string; include?: string[]; exclude?: string[]; all?: boolean; root?: string }
      : undefined;
    const coverageProvider = cov?.provider ?? 'v8';
    const coverage = cov ? { root: cov.root || projectRoot, include: cov.include, exclude: cov.exclude, all: cov.all } : undefined;
    log.debug(
      `Vitest projects of ${projectRoot} (${Date.now() - startedAt} ms): ${projects.map((p) => `${p.name || '(default)'}${p.browser ? ' [browser]' : ''}`).join(', ')}; ` +
      `coverage provider ${coverageProvider}, include ${JSON.stringify(coverage?.include ?? [])}`,
    );
    const maxWorkers = readWorkerLimit(result.stdout.split('\n').find((l) => l.startsWith('LTR_WORKERS ')));
    return { projects, coverageProvider, coverage, ...(maxWorkers !== undefined ? { maxWorkers } : {}) };
  } catch (err) {
    log.warn(`Could not parse the Vitest projects of ${projectRoot}`, err);
    return undefined;
  }
}

/** The probe's LTR_WORKERS line → the lowest worker limit it names (see VitestConfigInfo.maxWorkers). */
export function readWorkerLimit(line: string | undefined, cores?: number): number | undefined {
  if (!line) { return undefined; }
  try {
    const w = JSON.parse(line.slice('LTR_WORKERS '.length)) as { max?: unknown; pool?: unknown[] };
    const counts = [w.max, ...(Array.isArray(w.pool) ? w.pool : [])]
      .map((v) => workerCount(v, cores))
      .filter((n): n is number => n !== undefined);
    return counts.length > 0 ? Math.min(...counts) : undefined;
  } catch {
    return undefined;
  }
}

/** Absolute path of `vitest/node` (its `exports['./node']`) as the project resolves Vitest. */
function vitestNodeEntry(projectRoot: string): string | undefined {
  const dir = resolvePackageDir('vitest', projectRoot);
  if (!dir) { return undefined; }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> };
    const e = pkg.exports?.['./node'] as string | { import?: string | { default?: string }; default?: string } | undefined;
    const rel = typeof e === 'string' ? e
      : typeof e?.import === 'string' ? e.import
      : (e?.import as { default?: string } | undefined)?.default ?? e?.default;
    const file = rel ? path.join(dir, rel) : path.join(dir, 'dist', 'node.js');
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

function mtime(file: string | undefined): string {
  if (!file) { return '-'; }
  try { return String(fs.statSync(file).mtimeMs); } catch { return '-'; }
}
