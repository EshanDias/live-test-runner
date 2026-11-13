import { execFileSync } from 'child_process';
import * as fs from 'fs';
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

// ── Adaptive budget ────────────────────────────────────────────────────────────
// By default the level is where the budget starts: before each new test process
// it follows what the machine has free (up to Full's budget when idle, down to
// Light's when other apps keep the cores busy). `liveTestRunner.speedStrict`
// keeps it at the level.

let strict = false;
/** Keep runs at the speed level exactly (`liveTestRunner.speedStrict`), instead of adapting. */
export function setSpeedStrict(value: unknown): boolean {
  strict = value === true;
  return strict;
}
export function speedStrict(): boolean {
  return strict;
}

/**
 * Workers test processes may use together when the machine's other programs
 * keep `othersBusy` cores busy: every core but one (the editor's) that they
 * leave free, never below Light's budget nor above Full's. Strict, or nothing
 * measured yet: the level's own budget.
 */
export function adaptiveWorkers(
  cores: number,
  othersBusy: number | undefined,
  level: SpeedLevel = currentLevel,
  isStrict: boolean = strict,
  /** Physical cores; null: unknown (default: this machine's). */
  physical?: number | null,
): number {
  if (isStrict || othersBusy === undefined) { return totalWorkers(cores, level); }
  const free = Math.floor(cores - 1 - othersBusy);
  return Math.max(totalWorkers(cores, 'light'), Math.min(adaptiveCeiling(cores, physical, level), free));
}

/**
 * The most workers the adaptive budget reaches: Full's, and no more than the
 * physical cores but one where the OS says how many there are (never below the
 * level's own budget). Hyperthreads
 * double the logical cores without doubling the speed: on 6 cores / 12 threads,
 * 9 Jest processes took as long as 3 and used three times the memory.
 */
export function adaptiveCeiling(cores: number = coreCount(), physical?: number | null, level: SpeedLevel = currentLevel): number {
  const full = totalWorkers(cores, 'full');
  const p = physical === undefined ? physicalCores() : physical ?? undefined;
  // Never below the level's own budget: the level is where runs start.
  return p !== undefined && p > 0 ? Math.max(totalWorkers(cores, level), Math.min(full, p - 1)) : full;
}

let physicalCount: number | null | undefined;
/** Physical CPU cores (macOS: sysctl hw.physicalcpu; Linux: /proc/cpuinfo's cores), undefined where unknown (Windows). Read once. */
export function physicalCores(): number | undefined {
  if (physicalCount !== undefined) { return physicalCount ?? undefined; }
  physicalCount = null;
  try {
    if (process.platform === 'darwin') {
      const n = Number(execFileSync('sysctl', ['-n', 'hw.physicalcpu'], { encoding: 'utf8', timeout: 2000 }).trim());
      if (n > 0) { physicalCount = n; }
    } else if (process.platform === 'linux') {
      const cores = new Set<string>();
      let phys = '0';
      for (const line of fs.readFileSync('/proc/cpuinfo', 'utf8').split('\n')) {
        const m = /^(physical id|core id)\s*:\s*(\d+)/.exec(line);
        if (m && m[1] === 'physical id') { phys = m[2]; }
        if (m && m[1] === 'core id') { cores.add(`${phys}:${m[2]}`); }
      }
      if (cores.size > 0) { physicalCount = cores.size; }
    }
  } catch { /* unknown */ }
  return physicalCount ?? undefined;
}

/** The most test processes a run may keep going at once: strict, the level's; else the adaptive ceiling's workers (the budget gates each one). */
export function maxBatchSlots(cores: number = coreCount(), level: SpeedLevel = currentLevel, isStrict: boolean = strict): number {
  return isStrict ? parallelBatches(cores, level) : Math.max(parallelBatches(cores, level), adaptiveCeiling(cores));
}

interface CpuSample { at: number; idle: number; total: number; ours?: Map<number, number> }
let lastSample: CpuSample | undefined;
let lastBusy: number | undefined;
let lastOurs: number | undefined;

/** `ps` CPU time ("[[dd-]hh:]mm:ss[.ss]") in seconds. */
export function psSeconds(t: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim());
  return m ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
}

/** Memory of the largest test process with its workers (bytes), from the last sample; undefined where unknown. */
let largestTree: number | undefined;

/**
 * CPU seconds used so far by every process below this one (the test processes
 * and their workers), and the memory of the largest test process tree;
 * undefined where `ps` is not there (Windows).
 */
function descendantsCpu(root: number = process.pid): Map<number, number> | undefined {
  if (process.platform === 'win32') { return undefined; }
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 });
    const children = new Map<number, number[]>();
    const cpu = new Map<number, number>();
    const rss = new Map<number, number>();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)/.exec(line);
      if (!m) { continue; }
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      cpu.set(pid, psSeconds(m[3]));
      rss.set(pid, Number(m[4]) * 1024);
      (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    }
    const ours = new Map<number, number>();
    let largest: number | undefined;
    // Each child of ours is one test process (a batch); its subtree is it and its workers.
    for (const top of children.get(root) ?? []) {
      let tree = 0;
      const stack = [top];
      while (stack.length > 0) {
        const pid = stack.pop()!;
        ours.set(pid, cpu.get(pid) ?? 0);
        tree += rss.get(pid) ?? 0;
        stack.push(...(children.get(pid) ?? []));
      }
      largest = Math.max(largest ?? 0, tree);
    }
    largestTree = largest;
    return ours;
  } catch { return undefined; }
}

/**
 * Memory one more test process would take: the largest running one with its
 * workers (measured at the last load sample), undefined before any runs or
 * where it cannot be told.
 */
export function largestTestProcessMemory(): number | undefined {
  return largestTree;
}

function cpuSample(withOurs: boolean): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { at: Date.now(), idle, total, ours: withOurs ? descendantsCpu() : undefined };
}

/**
 * Cores the whole machine kept busy since the last sample (at least a second
 * apart; sooner, the last answer), and how many of them our own test
 * processes used (`ours`; undefined where it cannot be told). Undefined until
 * two samples exist.
 */
export function machineLoad(cores: number = coreCount()): { busy: number; ours?: number } | undefined {
  const now = cpuSample(true);
  if (!lastSample) { lastSample = now; return undefined; }
  const seconds = (now.at - lastSample.at) / 1000;
  if (seconds < 1) { return lastBusy === undefined ? undefined : { busy: lastBusy, ours: lastOurs }; }
  const total = now.total - lastSample.total;
  const idle = now.idle - lastSample.idle;
  if (total > 0) { lastBusy = Math.max(0, Math.min(cores, (1 - idle / total) * cores)); }
  if (now.ours && lastSample.ours) {
    let used = 0;
    for (const [pid, t] of now.ours) { used += Math.max(0, t - (lastSample.ours.get(pid) ?? 0)); }
    lastOurs = Math.min(cores, used / seconds);
  } else {
    lastOurs = undefined;
  }
  lastSample = now;
  return lastBusy === undefined ? undefined : { busy: lastBusy, ours: lastOurs };
}

/** Cores the whole machine kept busy lately (see machineLoad). */
export function machineBusyCores(cores: number = coreCount()): number | undefined {
  return machineLoad(cores)?.busy;
}

/**
 * Workers test processes may use now, with `ours` of them running: other
 * programs' share is the machine's busy cores less what our test processes
 * really used (measured; where it cannot be, each running worker counted as
 * a busy core). See adaptiveWorkers.
 */
export function workersNow(ours: number, cores: number = coreCount()): number {
  if (strict) { return totalWorkers(cores, currentLevel); }
  const load = machineLoad(cores);
  return adaptiveWorkers(cores, load === undefined ? undefined : Math.max(0, load.busy - (load.ours ?? ours)));
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
 * running: under 2 GB, or a fifth of the machine's memory when that is less,
 * once `another` (what the new process will take: the largest running one) is
 * taken off. A run always starts its first process; the next waits until one
 * ends or memory frees up, so test runs leave the user's other programs room
 * and a large project never pushes the machine into swap.
 */
export function memoryLow(available: number | undefined = availableMemory(), total: number = os.totalmem(), another: number = 0): boolean {
  return available !== undefined && available - another < Math.min(2 * GB, total * 0.2);
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
