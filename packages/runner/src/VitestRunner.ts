import * as path from 'path';
import { CommandRunner, RunRequest } from './CommandRunner';
import { ExecutionResult, ExecutorCommand, tail } from './execution/Executor';
import { FrameworkDetector } from './framework/FrameworkDetector';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { refusingAdapter } from './framework/refusingAdapter';
import type { VitestAdapter } from './framework/adapters/VitestAdapter';
import { vitestProjects } from './framework/vitestProjects';
import { VITEST_EVENTS_ENV, applyVitestEvents, readVitestEvents, vitestReporterFile } from './framework/vitestReporter';
import { RunResult } from './types';
import * as os from 'os';
import { FRAMEWORK_IDS } from './types';
import { createLogger } from './utils/logger';
import { fromRunnerPath, toRunnerPath } from './resolution/RunnerPaths';

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
 * Real path under a symlinked root (see RunnerPaths), forward slashes.
 */
export function toVitestPathArg(filePath: string): string {
  return toRunnerPath(filePath).replace(/\\/g, '/');
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
/** Reads a config's projects; replaceable in unit tests. */
let readProjects: typeof vitestProjects = vitestProjects;
/** For tests only: replace (or with no argument, restore) how projects are read. */
export function _setVitestProjectsReader(fn?: typeof vitestProjects): void {
  readProjects = fn ?? vitestProjects;
}

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
  async liveCommand(files: string[]): Promise<{ command: ExecutorCommand; eventsFile: string; resultFile: string }> {
    const request: RunRequest = { kind: 'files', files };
    const root = this.requireProjectRoot();
    const resultFile = path.join(this.tmpDir ?? os.tmpdir(), `ltr-result-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const env = this.runEnv(request) ?? {};
    const args = [...await this.commandArgs(request), ...this.requireAdapter().outputFileArg(resultFile)];
    return {
      command: { binary: this.resolveBinary(), args, cwd: root, extraEnv: env, label: this.processLabel, forwardStdout: true },
      eventsFile: env[VITEST_EVENTS_ENV],
      resultFile,
    };
  }

  protected detectAdapter(projectRoot: string): FrameworkAdapter {
    const adapter = this.detector.detect(projectRoot);
    if (adapter.framework === FRAMEWORK_IDS.vitest) { return adapter; }
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
    const projects = await readProjects(projectRoot, configPath, this.tmpDir ?? os.tmpdir(), this.logger);
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
   * like C:\Users\RUNNER~1 stays short, and the real-path file filters
   * (toVitestPathArg) would then match nothing. Running from the real path
   * keeps root, config and filters in one spelling.
   */
  protected override spawnPath(p: string): string {
    return toRunnerPath(p);
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
          ...(request.withCoverage
            ? ['--coverage.enabled=true', '--coverage.reporter=json', '--coverage.reporter=json-summary']
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

  protected coverageFile(projectRoot: string): string {
    // Vitest's default reportsDirectory; task 5.1 points it at the session dir.
    return path.join(projectRoot, 'coverage', 'coverage-final.json');
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
