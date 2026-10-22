/**
 * How many projects may run at once (D11) — pure, so it is unit-tested
 * without VS Code. The setting `liveTestRunner.maxRunningProjects` is
 * `"auto"` (default) or a number ≥ 1.
 */
import * as os from 'os';

const GB = 1024 ** 3;

/**
 * `auto`: 2, or 1 on a machine with ≤ 4 CPU cores or < 4 GB free memory —
 * every running project keeps its own test processes and on-save reruns.
 * Read at each Start (free memory changes).
 */
export function autoMaxRunningProjects(cpuCount: number = os.cpus().length, freeMemBytes: number = os.freemem()): number {
  return cpuCount <= 4 || freeMemBytes < 4 * GB ? 1 : 2;
}

/** The limit for a setting value; anything that is not a number ≥ 1 means `auto`. */
export function resolveMaxRunningProjects(
  setting: unknown,
  cpuCount: number = os.cpus().length,
  freeMemBytes: number = os.freemem(),
): number {
  const n = typeof setting === 'number' ? setting : typeof setting === 'string' && /^\d+$/.test(setting.trim()) ? Number(setting) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : autoMaxRunningProjects(cpuCount, freeMemBytes);
}

/**
 * The message shown when Start would exceed the limit, or undefined when the
 * project may start. `running` are the names of the projects already running
 * (the one being started is not among them).
 */
export function startRefusal(running: string[], limit: number): string | undefined {
  if (running.length < limit) { return undefined; }
  const names = running.map((n) => `"${n}"`).join(', ');
  return `Stop a running project first — ${names} ${running.length === 1 ? 'is' : 'are'} running and ` +
    `liveTestRunner.maxRunningProjects allows ${limit} at a time.`;
}
