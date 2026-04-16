import { Framework } from '../types';
import { FrameworkAdapter } from './adapters/FrameworkAdapter';
import { CRAAdapter } from './adapters/CRAAdapter';
import { JestAdapter } from './adapters/JestAdapter';
import { ViteAdapter } from './adapters/ViteAdapter';
import { logger } from '../utils/logger';

const FILE = 'FrameworkDetector.ts';

/**
 * Detects which test framework a project uses and returns the matching adapter.
 *
 * Adapters are checked in priority order — more specific frameworks first so
 * they are not eclipsed by the generic JestAdapter.
 *
 * Adding a new framework:
 *  1. Implement FrameworkAdapter
 *  2. Add an instance to ADAPTER_PRIORITY below (at the correct priority position)
 */

const ADAPTER_PRIORITY: FrameworkAdapter[] = [
  new CRAAdapter(),   // Must precede JestAdapter — CRA projects also have jest in deps
  new ViteAdapter(),  // Vitest projects
  new JestAdapter(),  // Plain Jest (and Next.js + Jest, etc.)
];

export class FrameworkDetector {
  /**
   * Returns the first adapter whose detect() returns true for the project root.
   * Falls back to JestAdapter if nothing else matches — a reasonable default
   * for any project that might have jest installed.
   */
  detect(projectRoot: string): FrameworkAdapter {
    for (const adapter of ADAPTER_PRIORITY) {
      try {
        if (adapter.detect(projectRoot)) {
          logger.info(FILE, 'detect', `Detected framework="${adapter.framework}" for "${projectRoot}"`);
          return adapter;
        }
      } catch (err) {
        logger.warn(FILE, 'detect', `Adapter "${adapter.framework}" threw during detect for "${projectRoot}" — skipping`, err);
      }
    }

    // Last-resort fallback so we never leave the caller without an adapter.
    logger.info(FILE, 'detect', `No specific framework detected for "${projectRoot}" — falling back to plain Jest`);
    return new JestAdapter();
  }

  /** Returns just the framework name without constructing a full adapter. */
  detectFramework(projectRoot: string): Framework {
    return this.detect(projectRoot).framework;
  }
}
