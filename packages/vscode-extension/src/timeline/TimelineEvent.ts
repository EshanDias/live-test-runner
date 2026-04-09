/**
 * TimelineEvent.ts — union type for all events emitted by the instrumentation layer.
 *
 * Events are written as JSON lines to a temp file during a Jest run and read by
 * JestInstrumentedRunner after Jest exits. The webview never sees raw events —
 * it only receives the fully assembled TimelineStore.
 */
import { VariableSnapshot } from './TimelineStore';

export type TimelineEvent =
  | { type: 'STEP';   stepId: number; line: number; file: string; functionName?: string }
  | { type: 'VAR';    stepId: number; name: string; snapshot: VariableSnapshot }
  | { type: 'ASSERT'; stepId: number; expected: any; actual: any; pass: boolean }
  | { type: 'ERROR';  stepId: number; message: string }
  | { type: 'LOG';    stepId: number; level: string; args: string[] };
