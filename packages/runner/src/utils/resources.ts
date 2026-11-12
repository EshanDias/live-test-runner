import * as os from 'os';

/**
 * The machine's parallelism budget, shared by every framework so that test
 * runs never take the whole machine, split across the batches the extension
 * runs at once. Its size is the speed level (`liveTestRunner.speed`):
 *   full      3/4 of the cores
 *   balanced  half the cores (the default)
 *   light     one test process with at most 2 workers
 */

/** How much of the machine test runs may use. */
export type SpeedLevel = 'full' | 'balanced' | 'light';
export const SPEED_LEVELS: readonly SpeedLevel[] = ['full', 'balanced', 'light'];

let currentLevel: SpeedLevel = 'balanced';
/** Set the level (the extension: from `liveTestRunner.speed`); anything unknown is balanced. */
export function setSpeedLevel(level: unknown): SpeedLevel {
  currentLevel = SPEED_LEVELS.includes(level as SpeedLevel) ? level as SpeedLevel : 'balanced';
  return currentLevel;
}
export function speedLevel(): SpeedLevel {
  return currentLevel;
}

/** Workers every test process together may use. */
export function totalWorkers(cores: number = coreCount(), level: SpeedLevel = currentLevel): number {
  if (level === 'light') { return Math.max(1, Math.min(2, Math.floor(cores / 4))); }
  return Math.max(1, Math.floor(cores * (level === 'full' ? 3 : 2) / 4));
}

/** Cores Node can use (`availableParallelism` where it exists). */
export function coreCount(): number {
  return Math.max(1, (os as { availableParallelism?: () => number }).availableParallelism?.() ?? os.cpus().length);
}

/** How many test processes (batches) run at once: one per two workers of the budget (light: one). */
export function parallelBatches(cores: number = coreCount(), level: SpeedLevel = currentLevel): number {
  return level === 'light' ? 1 : Math.max(1, Math.floor(totalWorkers(cores, level) / 2));
}

/**
 * Workers one test process may start, so that every batch running at once
 * together stays within the budget. A lower limit the project sets itself
 * (`maxWorkers`, `fileParallelism: false`) is kept.
 */
export function workersPerBatch(cores: number = coreCount(), projectLimit?: number, level: SpeedLevel = currentLevel): number {
  const budget = Math.max(1, Math.floor(totalWorkers(cores, level) / parallelBatches(cores, level)));
  return projectLimit !== undefined && projectLimit >= 1 ? Math.min(budget, Math.floor(projectLimit)) : budget;
}

/** A Vitest/Jest `maxWorkers` value (a count or a percentage like "50%") as a count. */
export function workerCount(value: unknown, cores: number = coreCount()): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) { return Math.floor(value); }
  if (typeof value === 'string') {
    // Trimmed first: no two `\s*` next to each other to backtrack over (polynomial ReDoS).
    const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(value.trim());
    if (!m) { return undefined; }
    const n = Number(m[1]);
    const count = m[2] ? Math.round((n / 100) * cores) : Math.floor(n);
    return Math.max(1, Math.min(cores, count));
  }
  return undefined;
}

const GB = 1024 ** 3;

/**
 * Memory the machine can still give without swapping, in bytes; undefined when
 * it cannot be told. `process.availableMemory` (Node 22, VS Code 1.90+) counts
 * free and reclaimable pages; older Node falls back to `os.freemem`, except on
 * macOS, where that counts only wholly free pages (a few hundred MB on a
 * machine with gigabytes to spare).
 */
export function availableMemory(): number | undefined {
  const fn = (process as { availableMemory?: () => number }).availableMemory;
  if (typeof fn === 'function') {
    try { const v = fn.call(process); if (v > 0) { return v; } } catch { /* fall back */ }
  }
  return process.platform === 'darwin' ? undefined : os.freemem();
}

/**
 * Too little memory left to start another test process beside the ones
 * running: under 2 GB, or a fifth of the machine's memory when that is less.
 * A run always starts its first process; the next waits until one ends or
 * memory frees up, so a large project never pushes the machine into swap.
 */
export function memoryLow(available: number | undefined = availableMemory(), total: number = os.totalmem()): boolean {
  return available !== undefined && available < Math.min(2 * GB, total * 0.2);
}

/**
 * Gives a test process a lower priority than the user's own work (Unix nice
 * 10, Windows below normal), so editing and other apps stay responsive while
 * tests run; on an idle machine it runs as fast as before. The processes it
 * starts (workers) inherit it. Best effort: nothing fails if the OS refuses.
 */
export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) { return; }
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* keep the default */ }
}
