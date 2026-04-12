/**
 * IInstrumentedRunner.ts — framework-agnostic contract for instrumented test runs.
 *
 * All instrumented runners (Jest, Vitest, Mocha, ...) implement this interface.
 * extension.ts holds a reference typed as IInstrumentedRunner — never to the
 * concrete class — so swapping framework implementations requires zero changes
 * to the activation logic.
 */
import { TimelineStore } from './TimelineStore';

export interface IInstrumentedRunner {
  run(options: {
    filePath: string;
    testFullName: string;
    projectRoot: string;
  }): Promise<TimelineStore>;

  cancel(): void;
}
