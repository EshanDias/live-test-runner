import { FileRunResult, TestCaseRunResult } from '../types';

/** Worst status wins: a test that failed anywhere is failed; one that ran beats one that was skipped. */
const STATUS_RANK: Record<TestCaseRunResult['status'], number> = {
  failed: 4, passed: 3, pending: 2, todo: 1, skipped: 0,
};

/**
 * Jest runs a file once for every project whose config includes it — e.g.
 * @testing-library/jest-dom runs each file under a `jsdom` and a `node`
 * project — and reports each run separately. Merges two reports of the same
 * file into one: a test fails if it failed in any project and keeps every
 * project's failure messages, so one report cannot hide another's failure.
 */
export function mergeFileResults(a: FileRunResult, b: FileRunResult): FileRunResult {
  const testCases = a.testCases.map((tc) => ({ ...tc, failureMessages: [...tc.failureMessages] }));
  // Match by full name and occurrence, so duplicate names pair up in order.
  const slots = new Map<string, number[]>();
  testCases.forEach((tc, i) => {
    const list = slots.get(tc.fullName) ?? [];
    list.push(i);
    slots.set(tc.fullName, list);
  });
  const used = new Map<string, number>();
  for (const tc of b.testCases) {
    const n = used.get(tc.fullName) ?? 0;
    used.set(tc.fullName, n + 1);
    const idx = slots.get(tc.fullName)?.[n];
    if (idx === undefined) {
      testCases.push({ ...tc, failureMessages: [...tc.failureMessages] });
      continue;
    }
    const prev = testCases[idx];
    testCases[idx] = {
      ...prev,
      status: STATUS_RANK[tc.status] > STATUS_RANK[prev.status] ? tc.status : prev.status,
      duration: Math.max(prev.duration ?? 0, tc.duration ?? 0) || prev.duration || tc.duration,
      failureMessages: [...prev.failureMessages, ...tc.failureMessages],
      location: prev.location ?? tc.location,
    };
  }

  const failureMessage = [a.failureMessage, b.failureMessage].filter(Boolean).join('\n\n') || undefined;
  const duration = (a.duration ?? 0) + (b.duration ?? 0);
  return {
    testFilePath: a.testFilePath,
    status: a.status === 'failed' || b.status === 'failed' ? 'failed' : 'passed',
    testCases,
    consoleOutput: [...a.consoleOutput, ...b.consoleOutput],
    failureMessage,
    duration: duration > 0 ? duration : undefined,
  };
}

/** Merges reports that share a file path, keeping first-seen order. */
export function mergeByFile(results: FileRunResult[]): FileRunResult[] {
  const byPath = new Map<string, FileRunResult>();
  for (const r of results) {
    const prev = byPath.get(r.testFilePath);
    byPath.set(r.testFilePath, prev ? mergeFileResults(prev, r) : r);
  }
  return [...byPath.values()];
}
