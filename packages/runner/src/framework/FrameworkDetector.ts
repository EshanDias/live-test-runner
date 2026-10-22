import { FRAMEWORK_IDS, FrameworkId } from '../types';
import { FrameworkAdapter } from './adapters/FrameworkAdapter';
import { JestAdapter } from './adapters/JestAdapter';
import { FrameworkRegistry } from './FrameworkRegistry';
import { createLogger } from '../utils/logger';

const log = createLogger('FrameworkDetector');

/** Which adapter a project got, and why. */
export interface DetectionResult {
  adapter: FrameworkAdapter;
  /** The adapter's id — `jest` also for the fallback (see `matched`). */
  framework: FrameworkId;
  /** `unknown` when no adapter matched and plain Jest was assumed. */
  matched: FrameworkId;
  /** One line for logs and the diagnostic report. */
  reason: string;
}

/** Roots already warned about, so the fallback WARN appears once per project, not per run. */
const warnedFallback = new Set<string>();

/**
 * Detects which test framework a project uses and returns the matching adapter.
 *
 * Adapters come from a {@link FrameworkRegistry} (the shipped ones by
 * default) and are tried in priority order — more specific frameworks first
 * so they are not eclipsed by the generic JestAdapter.
 *
 * Adding a new framework:
 *  1. Implement FrameworkAdapter
 *  2. Register it in FrameworkRegistry.default() (or a registry you pass in)
 */
export class FrameworkDetector {
  constructor(private readonly registry: FrameworkRegistry = FrameworkRegistry.default()) {}

  /**
   * Returns the first adapter whose detect() returns true for the project root.
   * Falls back to JestAdapter if nothing else matches — a reasonable default
   * for any project that might have jest installed.
   */
  detect(projectRoot: string): FrameworkAdapter {
    return this.detectWithReason(projectRoot).adapter;
  }

  /** {@link detect}, plus which adapter matched and why. */
  detectWithReason(projectRoot: string): DetectionResult {
    for (const adapter of this.registry.adapters()) {
      try {
        if (adapter.detect(projectRoot)) {
          // Runs on every JestRunner creation (i.e. every run) — keep it at trace.
          log.trace(`Framework "${adapter.framework}" detected for ${projectRoot}`);
          return {
            adapter,
            framework: adapter.framework,
            matched: adapter.framework,
            reason: `matched by the "${adapter.framework}" adapter`,
          };
        }
      } catch (err) {
        log.warn(`"${adapter.framework}" detection failed for ${projectRoot} — trying the next adapter`, err);
      }
    }

    // Last-resort fallback so we never leave the caller without an adapter.
    const adapter = this.registry.get(FRAMEWORK_IDS.jest) ?? new JestAdapter();
    if (!warnedFallback.has(projectRoot)) {
      warnedFallback.add(projectRoot);
      log.warn(
        `No test framework recognised in ${projectRoot} (no Jest, CRA or Vitest dependency or config) — assuming plain Jest`,
      );
    }
    return {
      adapter,
      framework: adapter.framework,
      matched: FRAMEWORK_IDS.unknown,
      reason: 'no adapter matched — assuming plain Jest',
    };
  }

  /** Returns just the framework name without constructing a full adapter. */
  detectFramework(projectRoot: string): FrameworkId {
    return this.detect(projectRoot).framework;
  }
}

/** For tests only: warn again about projects already reported as unrecognised. */
export function _resetDetectorWarnings(): void {
  warnedFallback.clear();
}
