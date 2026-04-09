/**
 * TimelineStore.ts — data contracts for a single instrumented test run.
 *
 * These interfaces are the source of truth for all timeline data. They are
 * populated by JestInstrumentedRunner after a run completes and serialised
 * in full to the webview in a single `timeline-ready` message.
 */

export interface VariableSnapshot {
  name: string;
  type: 'primitive' | 'object' | 'array';
  value?: any;       // set for primitives
  keys?: string[];   // top-level keys for objects/arrays; children filled lazily
  count?: number;    // item count for arrays
}

export interface Step {
  stepId: number;
  line: number;
  file: string;
  functionName?: string;
  pageName?: string;  // logical grouping for zoom levels
}

export interface LogEntry {
  text: string;
  level: 'log' | 'info' | 'warn' | 'error';
  timestamp: number;
}

export interface ErrorEntry {
  stepId: number;
  testName: string;
  failureMessages: string[];
}

export interface TimelineStore {
  testId: string;
  testFullName: string;
  filePath: string;
  steps: Step[];
  variables: Map<number, VariableSnapshot[]>;  // keyed by stepId
  logs: Map<number, LogEntry[]>;               // keyed by stepId
  errors: ErrorEntry[];
}
