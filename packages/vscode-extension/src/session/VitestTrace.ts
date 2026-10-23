/**
 * VitestTrace — decides, per project root and session, whether Vitest runs
 * with the execution trace, and writes the wrapper config that adds it.
 *
 * The wrapper (`<session>/vitest-trace/<root>/ltr.vitest.config.mjs`, passed
 * with `--config`) loads the project's own config with the project's Vite
 * and adds the trace plugin (instrumentation/vitest/: vitestTraceConfig.js,
 * vitestTracePlugin.js, vitestTraceTransform.js, vitestTraceSetup.mjs). See
 * ADR-9 in docs/temp_plans/vitest-support-plan.md.
 *
 * Off for a root (the run is then exactly today's, and source-file saves use
 * `vitest related`): the setting `liveTestRunner.vitestTrace` is off, Vitest
 * is older than 3, Vite cannot be found, the project uses a
 * `vitest.workspace.*` file, the wrapper reported it could not add the trace,
 * a traced batch produced no result at all, or a test file ran without the
 * trace setup. Each reason is logged once (WARN when something failed, INFO
 * when off by design) and kept until the next session.
 */
import * as fs from 'fs';
import * as path from 'path';
import { VitestAdapter as VitestRunnerAdapter, toSpawnPath, viteEntryFor, vitestDirFor } from '@live-test-runner/runner';
import { logger } from '../utils/logger';

const log = logger.scope('Vitest');

/** The instrumentation files, as shipped in out/ (see esbuild.js). */
export interface VitestTraceAssets {
  /** vitestTraceConfig.js — the wrapper's helper (and `wrapperSource`). */
  helper: string;
  /** vitestTraceSetup.mjs */
  setup: string;
  /** @babel/parser (out/vendor/babel-parser.js), used when the project has none. */
  parser: string;
}

export function defaultTraceAssets(): VitestTraceAssets {
  const dir = path.join(__dirname, 'instrumentation', 'vitest');
  return {
    helper: path.join(dir, 'vitestTraceConfig.js'),
    setup: path.join(dir, 'vitestTraceSetup.mjs'),
    parser: path.join(__dirname, 'vendor', 'babel-parser.js'),
  };
}

const WORKSPACE_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map((e) => `vitest.workspace.${e}`);

interface RootState {
  /** The wrapper config, once written. */
  config?: string;
  /** Why the trace is off for this root (this session). */
  off?: string;
}

export class VitestTrace {
  private readonly _roots = new Map<string, RootState>();
  private readonly _runnerAdapter = new VitestRunnerAdapter();

  /**
   * @param _sessionDir where wrapper configs and trace files go
   * @param _enabled reads `liveTestRunner.vitestTrace`
   */
  constructor(
    private readonly _sessionDir: string,
    private readonly _enabled: () => boolean,
    private readonly _assets: VitestTraceAssets = defaultTraceAssets(),
  ) {}

  /** A new session: every root is decided again (settings, installs and configs may have changed). */
  reset(): void {
    this._roots.clear();
  }

  /** Why covering tests / trace reruns are not available for this root, or undefined. */
  offReason(projectRoot: string): string | undefined {
    if (!this._enabled()) { return 'the execution trace is turned off (liveTestRunner.vitestTrace)'; }
    return this._roots.get(projectRoot)?.off;
  }

  /** Turns the trace off for the root until the next session. */
  turnOff(projectRoot: string, reason: string, level: 'info' | 'warn' = 'warn'): void {
    const state = this._state(projectRoot);
    if (state.off) { return; }
    state.off = reason;
    log[level](`Vitest execution trace is off for ${projectRoot}: ${reason}. ` +
      'Covering tests are not shown and saving a source file reruns its related test files (vitest related).');
  }

  /**
   * The wrapper config for a traced run, or undefined to run as configured.
   * @param configPath the project's own Vitest config (undefined: Vitest's defaults)
   */
  configFor(projectRoot: string, configPath: string | undefined): string | undefined {
    if (!this._enabled()) { return undefined; }
    const state = this._state(projectRoot);
    if (state.off) { return undefined; }
    if (state.config && fs.existsSync(state.config)) { return state.config; }
    try {
      state.config = this._write(projectRoot, configPath);
      return state.config;
    } catch (err) {
      this.turnOff(projectRoot, (err as Error).message, (err as { info?: boolean }).info ? 'info' : 'warn');
      return undefined;
    }
  }

  private _state(projectRoot: string): RootState {
    let s = this._roots.get(projectRoot);
    if (!s) { s = {}; this._roots.set(projectRoot, s); }
    return s;
  }

  private _write(projectRoot: string, configPath: string | undefined): string {
    const install = this._runnerAdapter.findInstall(projectRoot);
    if (!install) { throw new Error('Vitest is not installed'); }
    if (install.major < 3) { throw infoError(`Vitest ${install.version} is older than 3`); }
    const dirs = new Set([projectRoot, configPath ? path.dirname(configPath) : projectRoot]);
    for (const dir of dirs) {
      const ws = WORKSPACE_FILES.find((f) => fs.existsSync(path.join(dir, f)));
      if (ws) { throw infoError(`the project uses a Vitest workspace file (${ws}), which the trace does not support`); }
    }
    const vite = viteEntryFor(projectRoot);
    const vitestDir = vitestDirFor(projectRoot);
    if (!vite || !vitestDir) { throw new Error('Vite (used by Vitest) could not be found'); }
    for (const f of [this._assets.helper, this._assets.setup]) {
      if (!fs.existsSync(f)) { throw new Error(`the trace files are missing (${f}) — reinstall the extension`); }
    }
    const dir = path.join(this._sessionDir, 'vitest-trace', shortHash(projectRoot));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ltr.vitest.config.mjs');
    const { wrapperSource } = require(this._assets.helper) as { wrapperSource: (o: unknown) => string };
    fs.writeFileSync(file, wrapperSource({
      helper: this._assets.helper,
      vite,
      // Spelled as Vitest runs (its cwd, module ids): native realpath — Windows 8.3 names, macOS /private/var.
      config: configPath ? toSpawnPath(configPath) : null,
      projectRoot: toSpawnPath(projectRoot),
      major: install.major,
      setupFile: this._assets.setup,
      parser: this._assets.parser,
      wrapperDir: dir,
      vitestDir,
      selfFile: file,
    }), 'utf8');
    log.debug(`Vitest ${install.version}: execution trace wrapper for ${projectRoot} → ${file}`);
    return file;
  }
}

function infoError(message: string): Error {
  return Object.assign(new Error(message), { info: true });
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) ^ s.charCodeAt(i); }
  return (h >>> 0).toString(36);
}
