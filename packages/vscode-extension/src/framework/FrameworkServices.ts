/**
 * FrameworkServices — everything a session needs from one test framework,
 * bundled, so SessionManager never builds framework classes itself.
 *
 * SessionManager asks an {@link IFrameworkServicesProvider} for the bundle
 * of a file or project root. Today there is one bundle per window (Jest:
 * {@link createJestServices}); mixed-framework projects (phase 8) add a
 * provider that routes each file to its own framework's bundle.
 */
import { FrameworkDetector, FrameworkId, FRAMEWORK_IDS, TestRunner } from '@live-test-runner/runner';
import { logger } from '../utils/logger';
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

export interface FrameworkServices {
  /** The framework family this bundle serves (`jest` covers CRA too). */
  readonly framework: FrameworkId;
  /** Name shown to the user ("Jest"). */
  readonly displayName: string;
  /** Wording for log and status messages. */
  readonly terms: FrameworkTerms;
  /** Features beyond running tests. */
  readonly features: FrameworkFeatures;
  /** Discovery, single-file / test-case runs, debug configs, result mapping. */
  readonly adapter: IFrameworkAdapter;
  /** The project's resolved config, re-read every session. */
  readonly projectConfig: IProjectConfig;
  /** Session batches: results + trace + coverage. */
  readonly batchRunner: IBatchRunner;
  /** The Timeline debugger's runner; undefined when the framework has none yet (Vitest). */
  readonly instrumentedRunner: IInstrumentedRunner | undefined;
  /** A runner for core's TestSession (coverage map, stop). Reads the settings when called. */
  createSessionRunner(): TestRunner;
  /**
   * The user settings that change how the framework is called (and so which
   * files it lists) — part of the runnable-files cache key.
   */
  settingsFingerprint(): string;
}

export interface IFrameworkServicesProvider {
  /** The bundle for a test file, source file or project root. */
  servicesFor(fileOrRoot: string): FrameworkServices;
  /** Every bundle (Stop kills them all). */
  all(): FrameworkServices[];
}

/** One framework for every file — the only provider until mixed-framework support. */
export class SingleFrameworkProvider implements IFrameworkServicesProvider {
  constructor(private readonly _services: FrameworkServices) {}

  servicesFor(_fileOrRoot: string): FrameworkServices {
    return this._services;
  }

  all(): FrameworkServices[] {
    return [this._services];
  }
}

/**
 * Picks the bundle by the project's framework: Vitest for a Vitest project,
 * Jest (incl. CRA) otherwise. Bundles are built on first use and kept, so a
 * session's batch runner is the one Stop kills. Files are resolved to the
 * project root first (one root per window until phase 7).
 */
export class DetectingFrameworkProvider implements IFrameworkServicesProvider {
  private readonly _bundles = new Map<FrameworkId, FrameworkServices>();
  private readonly _byRoot = new Map<string, FrameworkId>();

  constructor(
    private readonly _factories: Record<'jest' | 'vitest', () => FrameworkServices>,
    /** The project root a file or root belongs to (undefined: no root yet). */
    private readonly _rootOf: (fileOrRoot: string) => string | undefined,
    private readonly _detector = new FrameworkDetector(),
  ) {}

  servicesFor(fileOrRoot: string): FrameworkServices {
    const root = this._rootOf(fileOrRoot) ?? fileOrRoot;
    let framework = this._byRoot.get(root);
    if (!framework) {
      let detected: FrameworkId = FRAMEWORK_IDS.jest;
      try { detected = this._detector.detectFramework(root); } catch { /* logged by the detector */ }
      framework = detected === FRAMEWORK_IDS.vitest ? FRAMEWORK_IDS.vitest : FRAMEWORK_IDS.jest;
      this._byRoot.set(root, framework);
      logger.scope('Framework').debug(`${root}: using the ${framework} services (detected "${detected}")`);
    }
    return this._bundle(framework as 'jest' | 'vitest');
  }

  all(): FrameworkServices[] {
    return [...this._bundles.values()];
  }

  /** Forget detected frameworks (e.g. the project root changed or package.json was edited). */
  resetDetection(): void {
    this._byRoot.clear();
  }

  private _bundle(framework: 'jest' | 'vitest'): FrameworkServices {
    let b = this._bundles.get(framework);
    if (!b) {
      b = this._factories[framework]();
      this._bundles.set(framework, b);
    }
    return b;
  }
}
