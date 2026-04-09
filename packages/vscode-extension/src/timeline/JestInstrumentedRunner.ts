/**
 * JestInstrumentedRunner.ts — Jest implementation of IInstrumentedRunner.
 *
 * run() currently returns a hardcoded empty TimelineStore.
 * parseEvents() reads a JSONL trace file and builds a real TimelineStore.
 * Wiring run() to actual Jest spawning happens in task 10.
 */
import * as fs from 'fs';
import { IInstrumentedRunner } from './IInstrumentedRunner';
import { TimelineStore, Step, VariableSnapshot, LogEntry, ErrorEntry } from './TimelineStore';
import { TimelineEvent } from './TimelineEvent';

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

  /**
   * Read a JSONL trace file produced by the instrumentation layer and assemble
   * a TimelineStore from it. Each line is a TimelineEvent JSON object.
   *
   * Public so it can be exercised directly in tests / smoke checks.
   */
  parseEvents(filePath: string): TimelineStore {
    const store: TimelineStore = {
      testId: '',
      testFullName: '',
      filePath: '',
      steps: [],
      variables: new Map(),
      logs: new Map(),
      errors: [],
    };

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    for (const line of lines) {
      let event: TimelineEvent;
      try {
        event = JSON.parse(line) as TimelineEvent;
      } catch {
        // skip malformed lines
        continue;
      }

      switch (event.type) {
        case 'STEP': {
          const step: Step = {
            stepId:       event.stepId,
            line:         event.line,
            file:         event.file,
            functionName: event.functionName,
          };
          store.steps.push(step);
          // Seed the maps so consumers always get an array (never undefined)
          if (!store.variables.has(event.stepId)) { store.variables.set(event.stepId, []); }
          if (!store.logs.has(event.stepId))      { store.logs.set(event.stepId, []); }
          break;
        }

        case 'VAR': {
          const snapshot: VariableSnapshot = event.snapshot;
          const existing = store.variables.get(event.stepId) ?? [];
          existing.push(snapshot);
          store.variables.set(event.stepId, existing);
          break;
        }

        case 'LOG': {
          const entry: LogEntry = {
            text:      event.args.join(' '),
            level:     event.level as LogEntry['level'],
            timestamp: Date.now(),
          };
          const existing = store.logs.get(event.stepId) ?? [];
          existing.push(entry);
          store.logs.set(event.stepId, existing);
          break;
        }

        case 'ERROR': {
          const existing = store.errors.find(e => e.stepId === event.stepId);
          if (existing) {
            existing.failureMessages.push(event.message);
          } else {
            const entry: ErrorEntry = {
              stepId:          event.stepId,
              testName:        store.testFullName,
              failureMessages: [event.message],
            };
            store.errors.push(entry);
          }
          break;
        }

        case 'ASSERT':
          // Assertions are not stored separately in TimelineStore for now —
          // failures are reported via ERROR events from the instrumentation layer.
          break;
      }
    }

    return store;
  }
}
