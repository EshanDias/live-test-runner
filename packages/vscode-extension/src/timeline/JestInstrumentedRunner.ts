/**
 * JestInstrumentedRunner.ts — Jest implementation of IInstrumentedRunner.
 *
 * Skeleton only: run() returns a hardcoded empty TimelineStore.
 * Actual instrumentation and Jest spawning are wired in later tasks.
 */
import { IInstrumentedRunner } from './IInstrumentedRunner';
import { TimelineStore } from './TimelineStore';

export class JestInstrumentedRunner implements IInstrumentedRunner {
  run(_options: {
    filePath: string;
    testFullName: string;
    projectRoot: string;
  }): Promise<TimelineStore> {
    const store: TimelineStore = {
      testId: '',
      testFullName: _options.testFullName,
      filePath: _options.filePath,
      steps: [],
      variables: new Map(),
      logs: new Map(),
      errors: [],
    };
    return Promise.resolve(store);
  }

  cancel(): void {
    // no-op stub — cancel logic wired in task 10
  }
}
