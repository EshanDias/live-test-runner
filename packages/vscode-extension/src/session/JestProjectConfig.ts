/**
 * JestProjectConfig — the project's Jest config exactly as Jest resolves it
 * (the Jest {@link IProjectConfig}).
 *
 * The instrumented runs (session batches and the timeline) write their own
 * temporary config and layer our transform / reporter / setup file on top of
 * the project's. Reading the project config ourselves only ever covered
 * jest.config.js / .cjs / package.json#jest, so TypeScript and ESM configs,
 * function exports, presets and `--config` in the test script were silently
 * lost (BUG-07). Instead we ask Jest: `jest --showConfig` (for Create React
 * App: `react-scripts test --showConfig`), once per session, and cache the
 * result as JSON that the generated configs `require`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BinaryResolver,
  Executor,
  FrameworkDetector,
  FRAMEWORK_IDS,
  pickGlobalConfig,
  tail,
  testScriptJestArgs,
  toInputConfig,
  toRunnerPath,
} from '@live-test-runner/runner';
import { logger } from '../utils/logger';
import { IProjectConfig } from './IProjectConfig';
import { CoverageScope, JestCoverageSettings, jestCoverageScope } from '../coverage/coverageScope';

const log = logger.scope('Config');

/** What the generated configs load: input-form project configs + kept global options. */
export interface ResolvedProjectConfig {
  configs: Record<string, unknown>[];
  global: Record<string, unknown>;
  jestVersion?: string;
  /** Which files count toward coverage (not read by the generated configs). */
  coverage?: JestCoverageSettings;
}

const SHOW_CONFIG_TIMEOUT_MS = 120_000;

export class JestProjectConfig implements IProjectConfig {
  private readonly _cache = new Map<string, Promise<string | undefined>>();
  private readonly _coverage = new Map<string, JestCoverageSettings>();

  /** @param _dir session folder where the resolved JSON is written */
  constructor(private readonly _dir: string, private readonly _rawLog: (msg: string) => void = () => {}) {}

  /** Forget cached configs (a new session re-reads them — the config may have changed). */
  reset(): void {
    this._cache.clear();
    this._coverage.clear();
  }

  /** From the same `--showConfig` read as {@link get}. */
  async coverageScope(projectRoot: string): Promise<CoverageScope | undefined> {
    await this.get(projectRoot);
    const settings = this._coverage.get(projectRoot);
    return settings ? jestCoverageScope(settings) : undefined;
  }

  /**
   * Path of a JSON file holding the {@link ResolvedProjectConfig}, or
   * undefined when Jest could not report its config (the caller falls back
   * to loading jest.config.js / package.json itself).
   */
  get(projectRoot: string): Promise<string | undefined> {
    let p = this._cache.get(projectRoot);
    if (!p) {
      p = this._resolve(projectRoot).catch((err) => {
        log.warn('Could not read the project\'s Jest config — falling back to jest.config.js / package.json', err);
        return undefined;
      });
      this._cache.set(projectRoot, p);
    }
    return p;
  }

  private async _resolve(projectRoot: string): Promise<string | undefined> {
    const startedAt = Date.now();
    const isCra = new FrameworkDetector().detect(projectRoot).framework === FRAMEWORK_IDS.cra;
    const scriptArgs = testScriptJestArgs(projectRoot);

    let binary: string | undefined;
    let args: string[];
    if (isCra) {
      binary = resolveReactScripts(projectRoot);
      args = ['test', '--showConfig', '--passWithNoTests', ...scriptArgs];
    } else {
      binary = BinaryResolver.resolveJestEntry(projectRoot);
      args = ['--showConfig', ...scriptArgs];
    }
    if (!binary) {
      log.debug(`No ${isCra ? 'react-scripts' : 'Jest'} install found in ${projectRoot} — cannot read its config`);
      return undefined;
    }

    const executor = new Executor(this._rawLog);
    const result = await executor.run({ binary, args, cwd: projectRoot, timeoutMs: SHOW_CONFIG_TIMEOUT_MS });
    const resolved = parseShowConfig(result.stdout);
    if (!resolved) {
      log.warn(
        `Jest could not report the project config (${isCra ? 'react-scripts test' : 'jest'} --showConfig) — ` +
        `falling back to reading jest.config.js / package.json. Jest said:\n${tail(result.stderr + '\n' + result.stdout, 15)}`,
      );
      return undefined;
    }

    fs.mkdirSync(this._dir, { recursive: true });
    const file = path.join(this._dir, `ltr-project-config-${hash(projectRoot)}.json`);
    fs.writeFileSync(file, JSON.stringify(resolved, null, 2), 'utf8');
    if (resolved.coverage) { this._coverage.set(projectRoot, resolved.coverage); }
    log.debug(
      `Project Jest config read via ${isCra ? 'react-scripts' : 'jest'} --showConfig in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s — Jest ${resolved.jestVersion ?? '?'}, ` +
      `${resolved.configs.length} project(s)${scriptArgs.length ? `, test-script args: ${scriptArgs.join(' ')}` : ''}`,
    );
    return file;
  }
}

/**
 * Transform pattern matching every JS/TS file under `projectRoot` outside
 * node_modules. Jest tests transform patterns against forward- or back-slashed
 * paths depending on version, and the drive letter's case is unpredictable on
 * Windows (VS Code gives `c:\`, Jest's realpath `C:\`), so both are accepted.
 * Built from the root's real path: Jest matches it against realpath'd files.
 */
export function sourceTransformPattern(projectRoot: string, extensions = '[jt]sx?'): string {
  const rootFwd = toRunnerPath(projectRoot).replace(/\\/g, '/');
  const driveMatch = rootFwd.match(/^([a-zA-Z]):(.*)/);
  const escapedRoot = driveMatch
    ? `[${driveMatch[1].toLowerCase()}${driveMatch[1].toUpperCase()}]:${escapeRegex(driveMatch[2])}`
    : escapeRegex(rootFwd);
  const escapedRootSlash = escapedRoot.replace(/\//g, '[/\\\\]');
  return `^${escapedRootSlash}[/\\\\](?!node_modules[/\\\\]).+\\.${extensions}$`;
}

/** `c:\x` → `C:\x` — the spelling Jest uses for its realpath'd rootDir. */
export function upperDrive(p: string): string {
  return p.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parses `--showConfig` stdout (may have text before the JSON). */
export function parseShowConfig(stdout: string): ResolvedProjectConfig | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) { return undefined; }
  let raw: { configs?: Record<string, unknown>[]; globalConfig?: Record<string, unknown>; version?: string };
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  const configs = Array.isArray(raw.configs) ? raw.configs : [];
  if (configs.length === 0) { return undefined; }
  return {
    // react-scripts sets `silent`, which would hide console output from the UI.
    configs: configs.map((c) => toInputConfig(c, ['silent'])),
    global: pickGlobalConfig(raw.globalConfig),
    jestVersion: raw.version,
    coverage: coverageSettings(configs, raw.globalConfig ?? {}),
  };
}

/** The options Jest's `shouldInstrument` reads, merged over every project. */
function coverageSettings(configs: Record<string, unknown>[], globalConfig: Record<string, unknown>): JestCoverageSettings {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : [];
  const all = (key: string) => [...new Set(configs.flatMap((c) => strings(c[key])))];
  const rootDir = typeof globalConfig.rootDir === 'string' ? globalConfig.rootDir
    : typeof configs[0].rootDir === 'string' ? configs[0].rootDir as string : '';
  return {
    rootDir,
    collectCoverageFrom: strings(globalConfig.collectCoverageFrom),
    coveragePathIgnorePatterns: configs.some((c) => Array.isArray(c.coveragePathIgnorePatterns))
      ? all('coveragePathIgnorePatterns')
      : undefined,
    testMatch: all('testMatch'),
    testRegex: all('testRegex'),
    setupFiles: [...all('setupFiles'), ...all('setupFilesAfterEnv'), ...all('globalSetup'), ...all('globalTeardown')],
  };
}

function resolveReactScripts(projectRoot: string): string | undefined {
  try {
    const pkg = require.resolve(['react-scripts', 'package.json'].join('/'), { paths: [projectRoot] });
    const bin = path.join(path.dirname(pkg), 'bin', 'react-scripts.js');
    return fs.existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) ^ s.charCodeAt(i); }
  return (h >>> 0).toString(36);
}
