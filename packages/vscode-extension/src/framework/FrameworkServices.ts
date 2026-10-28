/**
 * FrameworkServices — everything a session needs from one test framework,
 * bundled, so SessionManager never builds framework classes itself.
 *
 * SessionManager asks an {@link IFrameworkServicesProvider} for the bundle
 * of a file or project root. Each project has a FrameworkRouter
 * (`FrameworkRouter.ts`): one bundle for a single-framework project, and in
 * a mixed Jest + Vitest project (phase 8) each test file's own bundle.
 */
import { FrameworkId, TestRunner } from '@live-test-runner/runner';
import { IFrameworkAdapter } from './IFrameworkAdapter';
import { IProjectConfig } from '../session/IProjectConfig';
import { IBatchRunner } from '../session/IBatchRunner';
import { IInstrumentedRunner } from '../timeline/IInstrumentedRunner';

/** How log and status messages name the framework's pieces (Jest's are the historical wording). */
export interface FrameworkTerms {
  /** "Jest" */
  name: string;
  /** The project config that decides which files run: "Jest config". */
  config: string;
  /** The rules in it, short: "testMatch / testPathIgnorePatterns". */
  configRulesShort: string;
  /** The rules in it: "testMatch / testRegex / testPathIgnorePatterns". */
  configRules: string;
  /** The command that lists runnable files: "jest --listTests". */
  listCommand: string;
  /** The static related-tests fallback: "jest --findRelatedTests". */
  relatedCommand: string;
  /** The session's batch run: "instrumented run". */
  batchRun: string;
  /** A single-file run outside the batch: "plain Jest". */
  plainRun: string;
  /** What a file loses on that fallback: "slower; no coverage or smart reruns for these files". */
  fallbackLoss: string;
}

/** What a framework can do in the extension — features it lacks say "not available" instead of failing. */
export interface FrameworkFeatures {
  /** Per-test execution trace ("covering tests", trace-based reruns). */
  trace: boolean;
  /** The Timeline debugger. */
  timeline: boolean;
}

/**
 * How a framework's session runs are split into processes. Jest and Vitest
 * isolate test files themselves (workers), so several batches run side by
 * side within the machine's budget. Frameworks whose projects assume one
 * process at a time — pytest: session fixtures, fixed ports, shared files —
 * say so here; the budget then never starts a second process of theirs.
 */
export interface BatchPolicy {
  /** Most processes of this framework at once (default: the machine's budget). */
  maxParallel?: number;
  /** Most files in one process (default: sized from the run and the budget). */
  maxFilesPerBatch?: number;
}

export interface FrameworkServices {
  /** The framework family this bundle serves (`jest` covers CRA too). */
  readonly framework: FrameworkId;
  /** How session runs are split into processes (see {@link BatchPolicy}); undefined = the default. */
  readonly batchPolicy?: BatchPolicy;
  /** Name shown to the user ("Jest"). */
  readonly displayName: string;
  /** Wording for log and status messages. */
  readonly terms: FrameworkTerms;
  /** Features beyond running tests. */
  readonly features: FrameworkFeatures;
  /**
   * When the framework has the trace but it is off for this project root
   * (Vitest: setting off, or the wrapper config could not add it): why.
   * Undefined = available. Source-file saves then use the related run.
   */
  traceOffReason?(projectRoot: string): string | undefined;
  /** Discovery, single-file / test-case runs, debug configs, result mapping. */
  readonly adapter: IFrameworkAdapter;
  /** The project's resolved config, re-read every session. */
  readonly projectConfig: IProjectConfig;
  /** Session batches: results + trace + coverage. */
  readonly batchRunner: IBatchRunner;
  /** The Timeline debugger's runner; undefined when the framework has none yet (Vitest). */
  readonly instrumentedRunner: IInstrumentedRunner | undefined;
  /**
   * Before a session starts: why the framework cannot run this project now
   * (pytest: no Python environment with pytest — the user was told how to
   * fix it), or undefined when it can. Nothing runs while there is a reason.
   */
  whyNotReady?(projectRoot: string): Promise<string | undefined>;
  /** A runner for core's TestSession (coverage map, stop). Reads the settings when called. */
  createSessionRunner(): TestRunner;
  /**
   * The user settings that change how the framework is called (and so which
   * files it lists) — part of the runnable-files cache key.
   */
  settingsFingerprint(): string;
  /**
   * True for the framework's own config file (saving it restarts the
   * session: config, runnable files and every result are re-read).
   */
  isConfigFile(filePath: string, projectRoot: string): Promise<boolean>;
}

/** The project's runnable test files, across its frameworks. */
export interface RunnableListing {
  files: string[];
  /** Explorer groups (Vitest project names; the framework in a mixed project), by file. */
  groups?: Record<string, string>;
  /**
   * Mixed projects only: each listed file's framework and why
   * (`"vitest:hint"`) — remembered with the list, restored by
   * {@link IFrameworkServicesProvider.restore}.
   */
  frameworks?: Record<string, string>;
}

export interface IFrameworkServicesProvider {
  /** The bundle for a test file (its own framework), source file or project root (the main framework). */
  servicesFor(fileOrRoot: string): FrameworkServices;
  /** Every bundle in use (Stop kills them all). */
  all(): FrameworkServices[];
  /** Every Start, before anything runs: re-detects the framework(s) and re-reads the frameworks setting. */
  prepare(projectRoot: string): void;
  /**
   * Asks the framework(s) which files they run (`jest --listTests`,
   * `vitest list`). `discovered` = the statically found test files.
   * @throws when the (only) framework could not answer
   */
  listTestFiles(projectRoot: string, discovered: string[], rawLog: (msg: string) => void): Promise<RunnableListing>;
  /** A remembered listing is used instead of asking again: restore its per-file frameworks. */
  restore(listing: RunnableListing): void;
  /** A test file was saved: what it uses may have changed (mixed projects re-read its hint). */
  fileChanged(filePath: string): void;
  /** Part of the runnable-files cache key: the settings that change which files run where. */
  fingerprint(projectRoot: string): string;
  /** The project runs files with more than one framework. */
  isMixed(): boolean;
}

/** One framework for every file (unit tests, simple hosts). */
export class SingleFrameworkProvider implements IFrameworkServicesProvider {
  constructor(private readonly _services: FrameworkServices) {}

  servicesFor(_fileOrRoot: string): FrameworkServices {
    return this._services;
  }

  all(): FrameworkServices[] {
    return [this._services];
  }

  prepare(): void { /* nothing to detect */ }

  async listTestFiles(projectRoot: string, _discovered: string[], rawLog: (msg: string) => void): Promise<RunnableListing> {
    return listWith(this._services.adapter, projectRoot, rawLog);
  }

  restore(): void { /* one framework */ }
  fileChanged(): void { /* one framework */ }

  fingerprint(): string {
    return this._services.settingsFingerprint();
  }

  isMixed(): boolean { return false; }
}

/** One framework's listing: its own list command, or discovery when it has none. */
export async function listWith(adapter: IFrameworkAdapter, projectRoot: string, rawLog: (msg: string) => void): Promise<RunnableListing> {
  return adapter.listTestFiles
    ? adapter.listTestFiles(projectRoot, rawLog)
    : { files: await adapter.discoverTests(projectRoot, rawLog) };
}
