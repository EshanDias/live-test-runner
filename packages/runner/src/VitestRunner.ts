import * as path from 'path';
import { CommandRunner, RunRequest } from './CommandRunner';
import { ExecutionResult, ExecutorCommand, tail } from './execution/Executor';
import { FrameworkDetector } from './framework/FrameworkDetector';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { refusingAdapter } from './framework/refusingAdapter';
import { FrameworkRegistry } from './framework/FrameworkRegistry';
import { isFrameworkAllowedAt } from './framework/allowedFrameworks';
import type { VitestAdapter } from './framework/adapters/VitestAdapter';
import { VitestConfigInfo, vitestConfigInfo, vitestCoverageInstalled, vitestProjects } from './framework/vitestProjects';
import { VITEST_EVENTS_ENV, applyVitestEvents, readVitestEvents, vitestReporterFile } from './framework/vitestReporter';
import { RunResult } from './types';
import * as os from 'os';
import { FRAMEWORK_IDS } from './types';
import { createLogger } from './utils/logger';
import { fromRunnerPath, toSpawnPath } from './resolution/RunnerPaths';

const log = createLogger('VitestRunner');

/**
 * A test name pattern, built from the space-joined full name the json
 * reporter gives (`Outer Inner adds`), made to match the name Vitest tests
 * `-t` against: `Outer > Inner > adds` in Vitest 5, `Outer Inner adds` in
 * older versions. Every literal space becomes `(?: > | )`.
 *
 * The input is a regex whose literal parts are escaped (spaces are never
 * escaped), as the extension's `nameToPattern` builds it.
 */
export function toVitestNamePattern(testFullName: string, isTestSuite: boolean): string {
  const p = testFullName.replace(/ /g, '(?: > | )');
  // A suite matches the tests under it: its name followed by a separator.
  return isTestSuite ? `^(?:${p})(?: > | |$)` : `^(?:${p})$`;
}

/**
 * A file path as a Vitest positional filter. Vitest resolves filters against
 * its cwd and matches by path, so an absolute path selects exactly that file.
 * Spelled like Vitest's root and CLI entry (toSpawnPath), forward slashes.
 */
export function toVitestPathArg(filePath: string): string {
  return toSpawnPath(filePath).replace(/\\/g, '/');
}

/**
 * VitestRunner — the TestRunner for Vitest projects.
 *
 *   vitest run [files] [--config c] [script flags] --reporter=json --includeTaskLocation
 *          --passWithNoTests --watch=false [-t pattern] --outputFile=<tmp>
 *   vitest list [--config c] [script flags] --filesOnly --json
 *   vitest related <file> … --run …
 *
 * The subcommand and file paths come first (leadingArgs) so Vitest's option
 * parser never reads a path as a flag's value. `--reporter=json` is always
 * passed: it replaces reporters from the config (e.g. vueuse's `dot`), which
 * would otherwise leave no JSON to read. No `--root`: the project root is the
 * cwd, and a config's own `root` stays in charge.
 */
/** Reads a config's projects and coverage provider; replaceable in unit tests. */
let readConfig: typeof vitestConfigInfo = vitestConfigInfo;
/** For tests only: replace (or with no argument, restore) how the config is read. */
export function _setVitestConfigReader(fn?: typeof vitestConfigInfo): void {
  readConfig = fn ?? vitestConfigInfo;
}
/** For tests only: replace how projects are read (coverage provider: v8). */
export function _setVitestProjectsReader(fn?: typeof vitestProjects): void {
  readConfig = fn
    ? async (...args) => { const projects = await fn(...args); return projects && ({ projects, coverageProvider: 'v8' } as VitestConfigInfo); }
    : vitestConfigInfo;
}

/** Roots already told that coverage needs a provider package — once per root. */
const toldNoCoverage = new Set<string>();

/** Roots already told which browser projects were left out — once per root. */
const toldBrowserGuard = new Set<string>();

export class VitestRunner extends CommandRunner {
  protected readonly runnerName = 'VitestRunner';
  private readonly detector = new FrameworkDetector();
  /** `--project=<name>` for each non-browser project, when browser projects are left out. */
  private projectArgs: string[] = [];

  constructor(
    command = '',
    logger: (msg: string) => void = () => {},
    tmpDir?: string,
    private readonly includeBrowserProjects = false,
  ) {
    super(command, logger, tmpDir);
  }

  protected override get processLabel(): string { return 'vitest'; }

  /** Vitest's default reporter prints to stdout — that is its raw output. */
  protected override get forwardsStdout(): boolean { return true; }

  /** The events file of each run in flight (request → file). */
  private readonly eventFiles = new WeakMap<RunRequest, string>();

  protected override runEnv(request: RunRequest): Record<string, string> | undefined {
    if (request.kind === 'list') { return undefined; }
    const file = path.join(this.tmpDir ?? os.tmpdir(), `ltr-vitest-events-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    this.eventFiles.set(request, file);
    return { [VITEST_EVENTS_ENV]: file };
  }

  /**
   * What the reporter saw that the json report lacks: console output per
   * file with its scope (file / suite / test), and failures with their diff
   * and location — including a failing beforeAll / afterAll, whose error the
   * json report leaves out.
   */
  protected override afterRun(request: RunRequest, result: RunResult): RunResult {
    const file = this.eventFiles.get(request);
    if (!file) { return result; }
    return applyVitestEvents(result, readVitestEvents(file), this.requireProjectRoot());
  }

  /**
   * The command for a batch whose results are read live from the reporter's
   * events (see VitestBatchRunner in the extension): the same command as
   * runTestFilesJson, plus the events file and the json result file.
   */
  async liveCommand(
    files: string[],
    options: { coverageDir?: string; related?: string } = {},
  ): Promise<{ command: ExecutorCommand; eventsFile: string; resultFile: string; coverageFile?: string }> {
    // `related`: Vitest finds the test files that import this source file (`vitest related <src> --run`); `files` is ignored.
    const request: RunRequest = options.related ? { kind: 'related', file: options.related } : { kind: 'files', files };
    const root = this.requireProjectRoot();
    const resultFile = path.join(this.tmpDir ?? os.tmpdir(), `ltr-result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const env = this.runEnv(request) ?? {};
    const args = [...await this.commandArgs(request), ...this.requireAdapter().outputFileArg(resultFile)];
    const coverage = options.coverageDir ? await this.coverageArgs(root, options.coverageDir) : undefined;
    if (coverage) { args.push(...coverage); }
    return {
      command: { binary: this.spawnPath(this.resolveBinary()), args, cwd: this.spawnPath(root), extraEnv: env, label: this.processLabel, forwardStdout: true },
      eventsFile: env[VITEST_EVENTS_ENV],
      resultFile,
      coverageFile: coverage ? path.join(options.coverageDir!, 'coverage-final.json') : undefined,
    };
  }

  /**
   * Vitest's own coverage, as istanbul JSON in `dir` — when the configured
   * provider's package is installed (otherwise one INFO line says what to
   * install). Written even when tests fail; below Vitest 4, only files the
   * tests loaded (`all` would instrument the whole project).
   */
  private async coverageArgs(root: string, dir: string): Promise<string[] | undefined> {
    const info = await readConfig(root, await this.requireAdapter().resolveConfig(root), this.tmpDir ?? os.tmpdir(), this.logger);
    const provider = info?.coverageProvider ?? 'v8';
    if (!vitestCoverageInstalled(root, provider)) {
      if (!toldNoCoverage.has(root)) {
        toldNoCoverage.add(root);
        log.info(`Vitest coverage is off for ${root}: it needs @vitest/coverage-${provider} (e.g. npm i -D @vitest/coverage-${provider})`);
      }
      return undefined;
    }
    return [
      '--coverage.enabled=true',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${dir}`,
      '--coverage.reportOnFailure=true',
      ...(this.vitestMajor() < 4 ? ['--coverage.all=false'] : []),
    ];
  }

  protected detectAdapter(projectRoot: string): FrameworkAdapter {
    const adapter = this.detector.detect(projectRoot);
    if (adapter.framework === FRAMEWORK_IDS.vitest) { return adapter; }
    if (isFrameworkAllowedAt(projectRoot, 'vitest')) {
      const vitest = FrameworkRegistry.default().get(FRAMEWORK_IDS.vitest);
      if (vitest) {
        log.debug(`${projectRoot} is a "${adapter.framework}" project — running its Vitest files with Vitest (mixed frameworks)`);
        return vitest;
      }
    }
    log.debug(`${projectRoot} is a "${adapter.framework}" project — the Vitest runner will refuse to run it`);
    return refusingAdapter(adapter);
  }

  /**
   * Browser-mode projects (Playwright / WebdriverIO) need real browsers and are
   * left out unless the setting asks for them: every other project is named
   * with `--project`. Not applied when the test script picks projects itself.
   */
  protected override async prepare(projectRoot: string, configPath: string | undefined): Promise<void> {
    this.projectArgs = [];
    if (this.includeBrowserProjects) { return; }
    const scriptArgs = this.requireAdapter().getExtraArgs(projectRoot);
    if (scriptArgs.some((a) => a.startsWith('--project'))) { return; }
    const projects = (await readConfig(projectRoot, configPath, this.tmpDir ?? os.tmpdir(), this.logger))?.projects;
    const browser = (projects ?? []).filter((p) => p.browser);
    if (!projects || browser.length === 0) { return; }
    const others = projects.filter((p) => !p.browser);
    if (others.length === 0) {
      if (!toldBrowserGuard.has(projectRoot)) {
        toldBrowserGuard.add(projectRoot);
        log.warn(`Every Vitest project in ${projectRoot} uses browser mode — running them (they need their browsers installed)`);
      }
      return;
    }
    this.projectArgs = others.map((p) => `--project=${p.name}`);
    if (!toldBrowserGuard.has(projectRoot)) {
      toldBrowserGuard.add(projectRoot);
      log.info(
        `Vitest browser-mode projects left out: ${browser.map((p) => p.name).join(', ')} (they need real browsers). ` +
        'Set liveTestRunner.vitestIncludeBrowserProjects to run them too.',
      );
    }
  }

  /**
   * Vitest's root is its cwd as given (no realpath): on Windows an 8.3 name
   * like C:\Users\RUNNER~1 stays short. Its CLI entry, cwd, config and file
   * filters must all be spelled the same way, or nothing matches / Vitest
   * loads twice (see toSpawnPath).
   */
  protected override spawnPath(p: string): string {
    return toSpawnPath(p);
  }

  protected override leadingArgs(request: RunRequest): string[] {
    switch (request.kind) {
      case 'list':     return ['list'];
      case 'full':     return ['run'];
      case 'files':    return ['run', ...request.files.map(toVitestPathArg)];
      case 'testCase': return ['run', toVitestPathArg(request.file)];
      case 'related':
        return this.can('related') ? ['related', toVitestPathArg(request.file)] : ['run'];
    }
  }

  protected buildArgs(request: RunRequest): string[] {
    return [...this.projectArgs, ...this.kindArgs(request)];
  }

  private kindArgs(request: RunRequest): string[] {
    switch (request.kind) {
      case 'list':
        // `--json` takes an optional path: it must be last, or it eats the next token.
        return ['--filesOnly', '--json'];
      case 'full':
        return [
          ...this.resultArgs(),
          // Into the session dir, never the project's own coverage folder.
          ...(request.withCoverage
            ? ['--coverage.enabled=true', '--coverage.reporter=json', `--coverage.reportsDirectory=${this.fullRunCoverageDir()}`, '--coverage.reportOnFailure=true']
            : []),
        ];
      case 'files':
        return this.resultArgs();
      case 'testCase':
        return [...this.resultArgs(), '-t', toVitestNamePattern(request.testFullName, request.isTestSuite)];
      case 'related':
        if (!this.can('related')) {
          log.debug(`This Vitest has no reliable "related" — running every test for ${request.file}`);
          return this.resultArgs();
        }
        return ['--run', ...this.resultArgs()];
    }
  }

  protected parseTestList(result: ExecutionResult, projectRoot: string): string[] {
    const start = result.stdout.indexOf('[');
    if (start >= 0) {
      try {
        const entries = JSON.parse(result.stdout.slice(start)) as { file?: string }[];
        // A file in several projects is listed once per project.
        const files = [...new Set(entries.map((e) => e.file).filter((f): f is string => typeof f === 'string'))];
        log.debug(`vitest list found ${files.length} test file(s)`);
        return files.map((f) => fromRunnerPath(path.resolve(projectRoot, f)));
      } catch (err) {
        log.debug(`Could not read the vitest list output: ${(err as Error).message}`);
      }
    }
    log.warn(`vitest list gave no file list in ${projectRoot} — scanning the folder instead. Last output:\n${tail(result.stderr || result.stdout, 10)}`);
    return [];
  }

  /** `projectName` of each listed file — only when the config has two or more projects (D12). */
  protected override parseTestGroups(result: ExecutionResult, projectRoot: string): Record<string, string> | undefined {
    const start = result.stdout.indexOf('[');
    if (start < 0) { return undefined; }
    try {
      const entries = JSON.parse(result.stdout.slice(start)) as { file?: string; projectName?: string }[];
      const names = new Map<string, Set<string>>();
      for (const e of entries) {
        if (typeof e.file !== 'string' || typeof e.projectName !== 'string' || !e.projectName) { continue; }
        const file = fromRunnerPath(path.resolve(projectRoot, e.file));
        const set = names.get(file) ?? new Set<string>();
        set.add(e.projectName);
        names.set(file, set);
      }
      const distinct = new Set([...names.values()].flatMap((s) => [...s]));
      if (distinct.size < 2) { return undefined; }
      const groups: Record<string, string> = {};
      for (const [file, set] of names) { groups[file] = [...set].sort().join(', '); }
      return groups;
    } catch {
      return undefined;
    }
  }

  protected coverageFile(_projectRoot: string): string {
    return path.join(this.fullRunCoverageDir(), 'coverage-final.json');
  }

  private fullRunCoverageDir(): string {
    return path.join(this.tmpDir ?? os.tmpdir(), 'vitest-coverage');
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Flags every run that produces a result needs: Vitest's default reporter
   * (its own output, for the Test Output channel), ours (console output per
   * test) and json (the result, written to --outputFile.json).
   */
  private resultArgs(): string[] {
    return [
      '--reporter=default',
      `--reporter=${vitestReporterFile(this.tmpDir ?? os.tmpdir())}`,
      '--reporter=json',
      // `location` (test line numbers, for the gutter) — a CLI flag since Vitest 3.
      ...(this.vitestMajor() >= 3 ? ['--includeTaskLocation'] : []),
      '--passWithNoTests',
      '--watch=false',
    ];
  }

  /** Major version of the project's Vitest; unknown → assume current. */
  private vitestMajor(): number {
    const adapter = this.requireAdapter() as Partial<VitestAdapter>;
    return adapter.findInstall?.(this.requireProjectRoot())?.major ?? Number.MAX_SAFE_INTEGER;
  }

  /** A capability of the installed Vitest (per project root). */
  private can(capability: 'related'): boolean {
    return this.requireAdapter().capabilities(this.requireProjectRoot())[capability];
  }
}
