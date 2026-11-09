import * as os from 'os';

/**
 * The machine's parallelism budget, shared by every framework so that test
 * runs never take the whole machine: half the cores in total, split across
 * the batches the extension runs at once.
 */

/** Cores Node can use (`availableParallelism` where it exists). */
export function coreCount(): number {
  return Math.max(1, (os as { availableParallelism?: () => number }).availableParallelism?.() ?? os.cpus().length);
}

/** How many test processes (batches) run at once. */
export function parallelBatches(cores: number = coreCount()): number {
  return Math.max(1, Math.floor(cores / 4));
}

/**
 * Workers one test process may start, so that every batch running at once
 * together stays within half the cores. A lower limit the project sets
 * itself (`maxWorkers`, `fileParallelism: false`) is kept.
 */
export function workersPerBatch(cores: number = coreCount(), projectLimit?: number): number {
  const budget = Math.max(1, Math.floor(Math.max(1, Math.floor(cores / 2)) / parallelBatches(cores)));
  return projectLimit !== undefined && projectLimit >= 1 ? Math.min(budget, Math.floor(projectLimit)) : budget;
}

/** A Vitest/Jest `maxWorkers` value (a count or a percentage like "50%") as a count. */
export function workerCount(value: unknown, cores: number = coreCount()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) { return Math.floor(value); }
  if (typeof value === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(value);
    if (!m) { return undefined; }
    const n = Number(m[1]);
    const count = m[2] ? Math.round((n / 100) * cores) : Math.floor(n);
    return Math.max(1, Math.min(cores, count));
  }
  return undefined;
}
