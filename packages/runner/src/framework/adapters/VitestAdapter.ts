import * as fs from 'fs';
import * as path from 'path';
import { FRAMEWORK_IDS, FrameworkCapabilities, FrameworkId, RunResult } from '../../types';
import { RunnerOptions, TestRunner } from '../../TestRunner';
import { FrameworkAdapter } from './FrameworkAdapter';
import { JestAdapter, readPackageJson } from './JestAdapter';
import { parseVitestResult } from '../../parsing/VitestResultParser';
import { testScriptVitestArgs } from '../vitestConfig';
import { VitestRunner } from '../../VitestRunner';
import { NodeRuntime, nodeRuntime, nodeRuntimeVersion, resolvePackageBin, resolvePackageDir } from '../../resolution/BinaryResolver';
import { parseVersion, satisfies } from '../../utils/semver';
import { createLogger } from '../../utils/logger';

const log = createLogger('VitestAdapter');

/** Oldest Vitest major with full support (D2). Older majors run best-effort. */
export const VITEST_BASELINE_MAJOR = 3;

const CONFIG_EXTS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
/** Vitest's own lookup order: a vitest.config.* wins over a vite.config.*. */
export const VITEST_CONFIG_FILES = CONFIG_EXTS.map((e) => `vitest.config.${e}`);
export const VITE_CONFIG_FILES = CONFIG_EXTS.map((e) => `vite.config.${e}`);
/** Deprecated since Vitest 3.2 in favour of `test.projects`, still a clear Vitest marker. */
const VITEST_WORKSPACE_FILES = [...CONFIG_EXTS, 'json'].map((e) => `vitest.workspace.${e}`);

/** The Vitest install a project resolves. */
export interface VitestInstall {
  /** e.g. `5.0.5`. */
  version: string;
  major: number;
  /** Absolute path of the CLI entry (`vitest.mjs`), run with node. */
  entry: string;
  /** `engines.node` of the installed Vitest, if declared. */
  nodeRange?: string;
}

/** Capabilities of Vitest at a given major version. */
export function vitestCapabilities(major: number | undefined): FrameworkCapabilities {
  // Unknown version (not installed yet): assume a current Vitest; the run
  // itself reports the missing install.
  const modern = major === undefined || major >= VITEST_BASELINE_MAJOR;
  return {
    results: true,
    nameFilter: true,
    coverage: true,
    // Below 3: no `vitest list --filesOnly` / reliable `related`, and the
    // reporter API differs (onFinished/onTaskUpdate) — callers fall back to a
    // glob scan / full runs.
    listTests: modern,
    related: modern,
    liveStream: modern,
  };
}

/**
 * Handles Vitest projects.
 *
 * Detection: a `vitest` dependency or a Vitest config / workspace file — and
 * nothing that marks the project as Jest (BUG-37: libraries like jest-dom
 * list Vitest but run their tests on Jest). Mixed projects are phase 8.
 *
 * Binary: `vitest/package.json#bin` → `vitest.mjs`, resolved the way Node
 * would (local, hoisted, pnpm) and run with `node` — no `.bin` shim, so it
 * works on Windows without a shell. There is no npx fallback.
 *
 * Runtime: Vitest declares `engines.node` (v5: ^22.12.0 || ^24 || >=26). If
 * the only Node available is the editor's built-in one and it does not
 * satisfy that, resolving the binary fails with an explanation instead of a
 * cryptic crash inside Vitest.
 */
export class VitestAdapter implements FrameworkAdapter {
  readonly framework: FrameworkId = FRAMEWORK_IDS.vitest;

  /** Roots already told about (version below baseline, Node mismatch) — log once. */
  private readonly warned = new Set<string>();

  /** @param runtime The Node that will run Vitest (injectable for tests). */
  constructor(private readonly runtime: () => NodeRuntime = nodeRuntime) {}

  // ── Detection ──────────────────────────────────────────────────────────────

  detect(projectRoot: string): boolean {
    const pkg = readPackageJson(projectRoot);
    if (!pkg) { return false; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    const hasVitest =
      'vitest' in deps ||
      [...VITEST_CONFIG_FILES, ...VITEST_WORKSPACE_FILES].some((f) => fs.existsSync(path.join(projectRoot, f)));
    return hasVitest && !new JestAdapter().detect(projectRoot);
  }

  // ── Install, version, capabilities ─────────────────────────────────────────

  /** The Vitest the project resolves, or undefined when it is not installed. */
  findInstall(projectRoot: string): VitestInstall | undefined {
    const dir = resolvePackageDir('vitest', projectRoot);
    if (!dir) { return undefined; }
    let pkg: { version?: string; engines?: { node?: string } };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return undefined;
    }
    const entry = resolvePackageBin('vitest', 'vitest', projectRoot, 'vitest.mjs');
    const version = parseVersion(pkg.version);
    if (!entry || !version) { return undefined; }
    return { version: pkg.version!, major: version[0], entry, nodeRange: pkg.engines?.node };
  }

  capabilities(projectRoot: string): FrameworkCapabilities {
    return vitestCapabilities(this.findInstall(projectRoot)?.major);
  }

  // ── Binary resolution ──────────────────────────────────────────────────────

  resolveBinary(projectRoot: string): string {
    const install = this.findInstall(projectRoot);
    if (!install) {
      const msg =
        `[Live Test Runner] Vitest is not installed in ${projectRoot}. ` +
        'Run your package manager\'s install (npm / pnpm / yarn) and try again.';
      log.error(msg);
      throw new Error(msg);
    }
    this.checkVersion(projectRoot, install);
    this.checkRuntime(projectRoot, install);
    log.trace(`Vitest ${install.version} entry point: ${install.entry}`);
    return install.entry;
  }

  // ── Config resolution ──────────────────────────────────────────────────────

  /**
   * The `test` script's `--config`, else `vitest.config.*` before
   * `vite.config.*` (Vitest's own order); none → Vitest decides.
   */
  async resolveConfig(projectRoot: string): Promise<string | undefined> {
    const fromScript = testScriptVitestArgs(projectRoot).config;
    if (fromScript) { return fromScript; }
    for (const f of [...VITEST_CONFIG_FILES, ...VITE_CONFIG_FILES]) {
      const p = path.join(projectRoot, f);
      if (fs.existsSync(p)) { return p; }
    }
    return undefined;
  }

  /**
   * Config-relevant flags of the project's `test` script (`--project`,
   * `--root`, `--dir`, `--mode`, `--environment`, `--globals`, …), following
   * `nr` / `npm run` / `pnpm` into other scripts — so runs match `npm test`.
   * `--config` is returned by resolveConfig instead.
   */
  getExtraArgs(projectRoot: string): string[] {
    return testScriptVitestArgs(projectRoot).args;
  }

  // ── Results ────────────────────────────────────────────────────────────────

  /** The json reporter writes to `--outputFile` when it is the only reporter. */
  outputFileArg(file: string): string[] {
    return [`--outputFile=${file}`];
  }

  /** Vitest's json reporter: Jest's shape with Vitest's own quirks (see VitestResultParser). */
  parseResult(passed: boolean, raw: string, stderr: string): RunResult {
    return parseVitestResult(passed, raw, stderr);
  }

  createRunner(options: RunnerOptions = {}): TestRunner {
    return new VitestRunner(options.command ?? '', options.logger, options.tmpDir, options.includeBrowserProjects ?? false);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private checkVersion(projectRoot: string, install: VitestInstall): void {
    if (install.major >= VITEST_BASELINE_MAJOR) { return; }
    this.once(`version:${projectRoot}`, () => log.warn(
      `Vitest ${install.version} in ${projectRoot} is older than the supported ${VITEST_BASELINE_MAJOR}.x — ` +
      'runs and results work, but test listing, related tests and live progress are not available',
    ));
  }

  private checkRuntime(projectRoot: string, install: VitestInstall): void {
    if (!install.nodeRange) { return; }
    const runtime = this.runtime();
    const version = nodeRuntimeVersion(runtime);
    if (!version) { return; }
    const ok = satisfies(version, install.nodeRange);
    if (ok !== false) { return; } // satisfied, or a range we cannot read
    if (runtime.isEditorFallback) {
      const msg =
        `[Live Test Runner] Vitest ${install.version} needs Node ${install.nodeRange}, but no "node" was found on PATH, ` +
        `so the editor's built-in Node ${version} would be used — Vitest cannot run on it.\n` +
        'Install a supported Node and make sure VS Code can see it on PATH ' +
        '(on macOS, if VS Code was opened from the Dock, start it from a terminal with "code .").';
      log.error(msg);
      throw new Error(msg);
    }
    // The user's own Node: `npm test` uses the same one, so let Vitest decide.
    this.once(`node:${projectRoot}:${version}`, () => log.warn(
      `Vitest ${install.version} declares Node ${install.nodeRange}, but ${runtime.binary} is Node ${version} — ` +
      'the run may fail; upgrade Node if it does',
    ));
  }

  private once(key: string, fn: () => void): void {
    if (this.warned.has(key)) { return; }
    this.warned.add(key);
    fn();
  }
}
