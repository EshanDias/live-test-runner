import * as fs from 'fs';
import * as path from 'path';
import { RunRequest } from './CommandRunner';
import { ExecutionResult, tail } from './execution/Executor';
import { FrameworkAdapter } from './framework/adapters/FrameworkAdapter';
import { FrameworkRegistry } from './framework/FrameworkRegistry';
import { refusingAdapter } from './framework/refusingAdapter';
import { AngularProject, AngularWorkspace, angularProjectOf, readAngularWorkspace } from './framework/angularWorkspace';
import { vitestCoverageInstalled } from './framework/vitestProjects';
import { vitestReporterFile } from './framework/vitestReporter';
import { FRAMEWORK_IDS } from './types';
import { VITEST_COVERAGE_MODULE_ENV, VitestRunner, toVitestNamePattern } from './VitestRunner';
import { fromRunnerPath } from './resolution/RunnerPaths';
import { createLogger } from './utils/logger';

const log = createLogger('AngularRunner');

/** Where the runner config sends coverage (read by the config, set per run). */
export const ANGULAR_COVERAGE_DIR_ENV = 'LTR_NG_COVERAGE_DIR';

/** Roots already told that coverage needs @vitest/coverage-v8 — once per root. */
const toldNoCoverage = new Set<string>();

/**
 * AngularRunner — Angular's unit-test builder running Vitest.
 *
 *   ng test <project> --watch=false [--include <file> …] [--filter <pattern>]
 *      --reporters default --reporters <ours> --reporters json --output-file <tmp>
 *      --runner-config <session config> [--coverage --coverage-reporters json]
 *   ng test <project> --list-tests
 *
 * One command runs one Angular project (`ng test` with no name runs each in
 * turn and they would share the result file): a run's files must belong to
 * one project — the extension's batch runner splits batches by project. The
 * runner config (in the session folder, never the project) adds test line
 * numbers, the snapshot update flag and the coverage folder. `CI=true` keeps
 * Angular's persistent build cache (`.angular/cache`) out of the project.
 * Results, our reporter's events and coverage are read as for Vitest.
 */
export class AngularRunner extends VitestRunner {
  protected override readonly runnerName = 'AngularRunner';

  constructor(command = '', logger: (msg: string) => void = () => {}, tmpDir?: string) {
    super(command, logger, tmpDir, false);
  }

  protected override get processLabel(): string { return 'ng'; }

  protected override detectAdapter(projectRoot: string): FrameworkAdapter {
    const angular = FrameworkRegistry.default().get(FRAMEWORK_IDS.angular);
    if (angular?.detect(projectRoot)) { return angular; }
    log.debug(`${projectRoot} has no Angular project tested with Vitest — the Angular runner will refuse to run it`);
    return refusingAdapter(angular ?? FrameworkRegistry.default().adapters()[0]);
  }

  /** No Vitest config to read (browser projects, projects): the builder owns the config. */
  protected override async prepare(): Promise<void> { /* nothing */ }

  protected override runEnv(request: RunRequest): Record<string, string> | undefined {
    return {
      ...(super.runEnv(request) ?? {}),
      // Angular's build cache is on only "locally": with CI it stays off, nothing is written into the project.
      CI: 'true',
      ...(request.kind === 'full' && request.withCoverage ? { [ANGULAR_COVERAGE_DIR_ENV]: path.dirname(this.coverageFile(this.requireProjectRoot())) } : {}),
    };
  }

  /** A batch's command, with its coverage folder in the environment (read by the runner config). */
  override async liveCommand(files: string[], options: Parameters<VitestRunner['liveCommand']>[1] = {}): ReturnType<VitestRunner['liveCommand']> {
    const live = await super.liveCommand(files, { ...options, config: undefined, typecheckOnly: false });
    if (live.coverageFile && options.coverageDir) {
      live.command.extraEnv = { ...live.command.extraEnv, [ANGULAR_COVERAGE_DIR_ENV]: options.coverageDir };
    }
    return live;
  }

  protected override leadingArgs(request: RunRequest): string[] {
    const project = this.projectFor(request);
    return ['test', ...(project ? [project.name] : [])];
  }

  protected override buildArgs(request: RunRequest): string[] {
    const ws = this.workspace();
    const include = (files: string[]) => files.flatMap((f) => ['--include', this.relative(ws, f)]);
    switch (request.kind) {
      case 'list':
        return ['--list-tests'];
      case 'full':
        return [...this.ngResultArgs(request), ...(request.withCoverage ? this.builderCoverageArgs() : [])];
      case 'files':
        return [...include(request.files), ...this.ngResultArgs(request)];
      case 'testCase':
        return [...include([request.file]), '--filter', toVitestNamePattern(request.testFullName, request.isTestSuite), ...this.ngResultArgs(request)];
      case 'related':
        // The builder has no related run: every test of the file's project.
        log.debug(`ng test has no related run — running the tests of the project of ${path.basename(request.file)}`);
        return this.ngResultArgs(request);
    }
  }

  /** `Discovered test files:` then one path per line (relative to the workspace). */
  protected override parseTestList(result: ExecutionResult, projectRoot: string): string[] {
    const files: string[] = [];
    let inList = false;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (/^\s*Discovered test files:/i.test(line)) { inList = true; continue; }
      if (!inList) { continue; }
      const f = line.trim();
      if (!f) { continue; }
      if (!/\.[cm]?[jt]sx?$/.test(f)) { inList = false; continue; }
      files.push(fromRunnerPath(path.resolve(projectRoot, f)));
    }
    if (files.length === 0) {
      log.warn(`ng test --list-tests gave no file list in ${projectRoot} — scanning the folder instead. Last output:\n${tail(result.stderr || result.stdout, 10)}`);
    }
    return [...new Set(files)];
  }

  /** The Angular project of each listed file — when the workspace has two or more. */
  protected override parseTestGroups(result: ExecutionResult, projectRoot: string): Record<string, string> | undefined {
    const ws = this.workspace();
    if (ws.projects.length < 2) { return undefined; }
    const groups: Record<string, string> = {};
    for (const f of this.parseTestList(result, projectRoot)) {
      const p = angularProjectOf(ws, f);
      if (p) { groups[f] = p.name; }
    }
    return groups;
  }

  /**
   * The builder's coverage into `dir` (the runner config reads it from the
   * environment) — when the project has @vitest/coverage-v8 (or -istanbul):
   * the builder prepares its build for the provider it finds there.
   */
  /** No Vitest flags for `ng test`: the runner config names the provider (from the environment). */
  protected override perTestFileProviderArgs(): string[] {
    return [];
  }

  protected override async coverageArgs(root: string, dir: string): Promise<{ args: string[]; provider: string } | undefined> {
    if (!vitestCoverageInstalled(root, 'v8') && !vitestCoverageInstalled(root, 'istanbul')) {
      if (!toldNoCoverage.has(root)) {
        toldNoCoverage.add(root);
        log.info(`Angular coverage is off for ${root}: it needs @vitest/coverage-v8 (e.g. npm i -D @vitest/coverage-v8)`);
      }
      return undefined;
    }
    void dir; // goes to the runner config through the environment (liveCommand)
    return { args: this.builderCoverageArgs(), provider: vitestCoverageInstalled(root, 'v8') ? 'v8' : 'istanbul' };
  }

  private builderCoverageArgs(): string[] {
    return ['--coverage', '--coverage-reporters', 'json'];
  }

  /** The project of the request's file(s); undefined: every project (`ng test` alone). */
  private projectFor(request: RunRequest): AngularProject | undefined {
    const ws = this.workspace();
    const files = request.kind === 'files' ? request.files : request.kind === 'testCase' || request.kind === 'related' ? [request.file] : [];
    if (files.length === 0) { return ws.projects.length === 1 ? ws.projects[0] : undefined; }
    const project = angularProjectOf(ws, fromRunnerPath(files[0]));
    const others = files.filter((f) => angularProjectOf(ws, fromRunnerPath(f)) !== project);
    if (others.length) {
      log.warn(`A run mixed files of several Angular projects — running only those of "${project?.name}" (${others.length} left out)`);
    }
    return project ?? (ws.projects.length === 1 ? ws.projects[0] : undefined);
  }

  /**
   * Flags every run that produces a result needs: Vitest's default reporter,
   * ours (console output per test, live events), json (the result), and the
   * runner config.
   */
  private ngResultArgs(request: RunRequest): string[] {
    const tmp = this.workDir;
    return [
      '--watch=false',
      '--reporters', 'default',
      '--reporters', vitestReporterFile(tmp),
      '--reporters', 'json',
      '--runner-config', this.runnerConfig(request.kind === 'testCase' && !!request.updateSnapshots),
    ];
  }

  /**
   * Our runner config, in the session folder: test line numbers, the
   * snapshot update flag (the builder has no `-u`), and the coverage folder
   * from the environment (json only, never the project's coverage folder).
   */
  private runnerConfig(update: boolean): string {
    const file = path.join(this.workDir, `ltr-ng-runner${update ? '-update' : ''}.config.mjs`);
    const source = [
      '// Live Test Runner: options for Angular\'s unit-test builder (ng test --runner-config).',
      'const coverageDir = process.env.' + ANGULAR_COVERAGE_DIR_ENV + ';',
      '// Coverage per test file: the extension\'s wrapper provider (it loads the project\'s own), which Vite must be allowed to load.',
      'const perFile = coverageDir ? process.env.' + VITEST_COVERAGE_MODULE_ENV + ' : undefined;',
      'const fsAllow = perFile ? [process.cwd(), perFile.replace(/[\\\\/][^\\\\/]+$/, \'\')] : undefined;',
      'export default {',
      '  test: {',
      '    includeTaskLocation: true,',
      '    passWithNoTests: true,',
      ...(update ? ['    update: true,'] : []),
      '    ...(coverageDir ? { coverage: { reportsDirectory: coverageDir, reportOnFailure: true, ...(perFile ? { provider: \'custom\', customProviderModule: perFile } : {}) } } : {}),',
      '  },',
      '  ...(fsAllow ? { server: { fs: { allow: fsAllow } } } : {}),',
      '};',
      '',
    ].join('\n');
    try {
      let current: string | undefined;
      try { current = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
      if (current !== source) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source, 'utf8');
      }
    } catch (err) {
      log.warn(`Could not write the Angular runner config ${file}: ${(err as Error).message}`);
    }
    return file;
  }

  private workspace(): AngularWorkspace {
    return readAngularWorkspace(this.requireProjectRoot()) ?? { root: this.requireProjectRoot(), projects: [], karma: [] };
  }

  /** A path as the builder's `--include` takes it: relative to the workspace, forward slashes. */
  private relative(ws: AngularWorkspace, file: string): string {
    return path.relative(ws.root, fromRunnerPath(file)).split(path.sep).join('/');
  }
}
