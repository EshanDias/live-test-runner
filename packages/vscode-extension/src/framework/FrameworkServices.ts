/**
 * FrameworkServices — everything a session needs from one test framework,
 * bundled, so SessionManager never builds framework classes itself.
 *
 * SessionManager asks an {@link IFrameworkServicesProvider} for the bundle
 * of a file or project root. Today there is one bundle per window (Jest:
 * {@link createJestServices}); mixed-framework projects (phase 8) add a
 * provider that routes each file to its own framework's bundle.
 */
import { FrameworkId, TestRunner } from '@live-test-runner/runner';
import { IFrameworkAdapter } from './IFrameworkAdapter';
import { IProjectConfig } from '../session/IProjectConfig';
import { IBatchRunner } from '../session/IBatchRunner';
import { IInstrumentedRunner } from '../timeline/IInstrumentedRunner';

export interface FrameworkServices {
  /** The framework family this bundle serves (`jest` covers CRA too). */
  readonly framework: FrameworkId;
  /** Name shown to the user ("Jest"). */
  readonly displayName: string;
  /** Discovery, single-file / test-case runs, debug configs, result mapping. */
  readonly adapter: IFrameworkAdapter;
  /** The project's resolved config, re-read every session. */
  readonly projectConfig: IProjectConfig;
  /** Session batches: results + trace + coverage. */
  readonly batchRunner: IBatchRunner;
  /** The Timeline debugger's runner. */
  readonly instrumentedRunner: IInstrumentedRunner;
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
