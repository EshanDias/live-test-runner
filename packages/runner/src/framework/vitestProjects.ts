import * as fs from 'fs';
import * as path from 'path';
import { Executor } from '../execution/Executor';
import { resolvePackageDir } from '../resolution/BinaryResolver';
import { toRunnerPath } from '../resolution/RunnerPaths';
import { createLogger } from '../utils/logger';

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
process.stdout.write('\\nLTR_PROJECTS ' + JSON.stringify(projects) + '\\n');
await vitest.close();
process.exit(0);
`;

const cache = new Map<string, { stamp: string; projects: Promise<VitestProjectInfo[] | undefined> }>();

/**
 * The projects of the Vitest config in `projectRoot` (undefined when they
 * cannot be read — callers then apply no project filter). Cached until the
 * config file or package.json changes.
 */
export function vitestProjects(
  projectRoot: string,
  configPath: string | undefined,
  tmpDir: string,
  logger?: (msg: string) => void,
): Promise<VitestProjectInfo[] | undefined> {
  const stamp = [configPath ?? '', mtime(configPath), mtime(path.join(projectRoot, 'package.json'))].join('|');
  const hit = cache.get(projectRoot);
  if (hit && hit.stamp === stamp) { return hit.projects; }
  const projects = probe(projectRoot, configPath, tmpDir, logger);
  cache.set(projectRoot, { stamp, projects });
  return projects;
}

/** For tests only. */
export function _resetVitestProjects(): void {
  cache.clear();
}

async function probe(
  projectRoot: string,
  configPath: string | undefined,
  tmpDir: string,
  logger?: (msg: string) => void,
): Promise<VitestProjectInfo[] | undefined> {
  const nodeEntry = vitestNodeEntry(projectRoot);
  if (!nodeEntry) {
    log.debug(`No vitest/node entry under ${projectRoot} — not reading its projects`);
    return undefined;
  }
  const script = path.join(tmpDir, 'ltr-vitest-projects.mjs');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(script, PROBE, 'utf8');
  } catch (err) {
    log.warn(`Could not write the Vitest project probe to ${tmpDir}`, err);
    return undefined;
  }
  const startedAt = Date.now();
  const result = await new Executor(logger).run({
    binary: script,
    // Real path, like the runs (see VitestRunner.spawnPath).
    args: [nodeEntry, configPath ? toRunnerPath(configPath) : ''],
    cwd: toRunnerPath(projectRoot),
    timeoutMs: 60_000,
    label: 'vitest',
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('LTR_PROJECTS '));
  if (!line) {
    log.warn(`Could not read the Vitest projects of ${projectRoot} — running without a project filter`);
    return undefined;
  }
  try {
    const projects = JSON.parse(line.slice('LTR_PROJECTS '.length)) as VitestProjectInfo[];
    log.debug(`Vitest projects of ${projectRoot} (${Date.now() - startedAt} ms): ${projects.map((p) => `${p.name || '(default)'}${p.browser ? ' [browser]' : ''}`).join(', ')}`);
    return projects;
  } catch (err) {
    log.warn(`Could not parse the Vitest projects of ${projectRoot}`, err);
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
