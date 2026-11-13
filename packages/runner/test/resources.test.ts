import * as os from 'os';
import { spawn } from 'child_process';
import { adaptiveWorkers, availableMemory, physicalCores, psSeconds, machineLoad, largestTestProcessMemory, lowerPriority, machineBusyCores, maxBatchSlots, memoryLow, parallelBatches, setSpeedLevel, setSpeedStrict, speedLevel, totalWorkers, workerCount, workersNow, workersPerBatch } from '../src/utils/resources';
import { readWorkerLimit } from '../src/framework/vitestProjects';

describe('machine budget', () => {
  it.each([
    [1, 1, 1], [2, 1, 1], [4, 1, 2], [8, 2, 2], [10, 2, 2], [12, 3, 2], [16, 4, 2], [32, 8, 2],
  ])('%i cores → %i batches × %i workers', (cores, batches, workers) => {
    expect(parallelBatches(cores)).toBe(batches);
    expect(workersPerBatch(cores)).toBe(workers);
  });

  it('keeps every batch together within half the cores (at least one worker)', () => {
    for (let cores = 1; cores <= 64; cores++) {
      expect(parallelBatches(cores) * workersPerBatch(cores)).toBeLessThanOrEqual(Math.max(1, Math.floor(cores / 2)));
    }
  });

  it("keeps a lower limit the project sets, never raises to it", () => {
    expect(workersPerBatch(16, 1)).toBe(1);
    expect(workersPerBatch(16, 8)).toBe(2);
    expect(workersPerBatch(16, 0)).toBe(2);
  });
});

describe('workerCount', () => {
  it('reads counts and percentages', () => {
    expect(workerCount(3, 10)).toBe(3);
    expect(workerCount('50%', 10)).toBe(5);
    expect(workerCount('1%', 10)).toBe(1);
    expect(workerCount('200%', 10)).toBe(10);
    expect(workerCount('4', 10)).toBe(4);
    expect(workerCount(' 50% ', 10)).toBe(5);
    expect(workerCount('50 %', 10)).toBeUndefined();
    expect(workerCount('9' + ' '.repeat(100_000) + 'x', 10)).toBeUndefined();
    expect(workerCount(null, 10)).toBeUndefined();
    expect(workerCount('lots', 10)).toBeUndefined();
    expect(workerCount(0, 10)).toBeUndefined();
  });
});

describe("the Vitest probe's worker line", () => {
  it('takes the lowest limit the config sets', () => {
    expect(readWorkerLimit('LTR_WORKERS {"max":"50%","pool":[]}', 10)).toBe(5);
    expect(readWorkerLimit('LTR_WORKERS {"max":6,"pool":[2]}', 10)).toBe(2);
    expect(readWorkerLimit('LTR_WORKERS {"max":1,"pool":[]}', 10)).toBe(1);
  });

  it('is undefined when the config sets none, or the line is missing or broken', () => {
    expect(readWorkerLimit('LTR_WORKERS {"max":null,"pool":[]}', 10)).toBeUndefined();
    expect(readWorkerLimit(undefined)).toBeUndefined();
    expect(readWorkerLimit('LTR_WORKERS {nope')).toBeUndefined();
  });
});

describe('memory check', () => {
  const GB = 1024 ** 3;
  it('is low under 2 GB free, or a fifth of the memory on a small machine', () => {
    expect(memoryLow(1.9 * GB, 16 * GB)).toBe(true);
    expect(memoryLow(2.1 * GB, 16 * GB)).toBe(false);
    expect(memoryLow(1.7 * GB, 8 * GB)).toBe(false);
    expect(memoryLow(1.5 * GB, 8 * GB)).toBe(true);
    expect(memoryLow(1.5 * GB, 4 * GB)).toBe(false);
    expect(memoryLow(0.7 * GB, 4 * GB)).toBe(true);
  });

  it('never holds a run back when free memory cannot be told', () => {
    expect(memoryLow(undefined, 16 * GB)).toBe(false);
  });

  it('reads a positive amount, or nothing', () => {
    const free = availableMemory();
    expect(free === undefined || (free > 0 && free <= os.totalmem() * 1.01)).toBe(true);
  });
});

describe('test process priority', () => {
  it('lowers a started process below normal, and never throws', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
      lowerPriority(child.pid);
      expect(os.getPriority(child.pid!)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    } finally {
      child.kill();
    }
    expect(() => lowerPriority(undefined)).not.toThrow();
    expect(() => lowerPriority(2 ** 30)).not.toThrow();
  });
});

describe('speed levels', () => {
  afterEach(() => { setSpeedLevel('balanced'); });

  it.each([
    // cores, level, batches, workers each
    [12, 'full', 4, 2], [12, 'balanced', 3, 2], [12, 'light', 1, 2],
    [8, 'full', 3, 2], [8, 'balanced', 2, 2], [8, 'light', 1, 2],
    [4, 'full', 1, 3], [4, 'balanced', 1, 2], [4, 'light', 1, 1],
    [2, 'full', 1, 1], [2, 'balanced', 1, 1], [2, 'light', 1, 1],
    [32, 'full', 12, 2], [32, 'light', 1, 2],
  ] as const)('%i cores, %s → %i batches × %i workers', (cores, level, batches, workers) => {
    expect(parallelBatches(cores, level)).toBe(batches);
    expect(workersPerBatch(cores, undefined, level)).toBe(workers);
  });

  it('every level stays within its budget; full ≥ balanced ≥ light', () => {
    for (let cores = 1; cores <= 64; cores++) {
      for (const level of ['full', 'balanced', 'light'] as const) {
        expect(parallelBatches(cores, level) * workersPerBatch(cores, undefined, level)).toBeLessThanOrEqual(totalWorkers(cores, level));
      }
      expect(totalWorkers(cores, 'full')).toBeGreaterThanOrEqual(totalWorkers(cores, 'balanced'));
      expect(totalWorkers(cores, 'balanced')).toBeGreaterThanOrEqual(totalWorkers(cores, 'light'));
      expect(totalWorkers(cores, 'full')).toBeLessThan(Math.max(2, cores));
    }
  });

  it('balanced is the default and what an unknown value means; the level set is used', () => {
    expect(speedLevel()).toBe('balanced');
    expect(setSpeedLevel('turbo')).toBe('balanced');
    expect(setSpeedLevel(undefined)).toBe('balanced');
    setSpeedLevel('light');
    expect(parallelBatches(12)).toBe(1);
    expect(workersPerBatch(12)).toBe(2);
    setSpeedLevel('full');
    expect(parallelBatches(12)).toBe(4);
  });
});

describe('adaptive budget (the level is where it starts)', () => {
  afterEach(() => { setSpeedStrict(false); setSpeedLevel('balanced'); });

  it('an idle machine: every core but one, up to Full (physical cores unknown)', () => {
    expect(adaptiveWorkers(12, 0, 'balanced', false, null)).toBe(totalWorkers(12, 'full'));   // 9 (11 free, Full caps)
    expect(adaptiveWorkers(4, 0, 'light', false, null)).toBe(3);                                // 3 free = Full's 3
  });

  it('no more than the physical cores but one (hyperthreads are not cores)', () => {
    expect(adaptiveWorkers(12, 0, 'light', false, 6)).toBe(5);
    expect(adaptiveWorkers(12, 0, 'balanced', false, 6)).toBe(6);       // never below the level's own 6
    expect(adaptiveWorkers(16, 0, 'balanced', false, 16)).toBe(12);     // Full's 3/4 is lower
    expect(adaptiveWorkers(8, 0, 'light', false, 2)).toBe(2);           // never below Light
  });

  it('other programs busy: what they leave free, never below Light', () => {
    expect(adaptiveWorkers(12, 4, 'balanced', false, null)).toBe(7);
    expect(adaptiveWorkers(12, 10.5, 'full', false, null)).toBe(totalWorkers(12, 'light'));      // 2
    expect(adaptiveWorkers(4, 3, 'balanced', false, null)).toBe(totalWorkers(4, 'light'));       // 1
  });

  it('nothing measured yet, or strict: the level as set', () => {
    expect(adaptiveWorkers(12, undefined, 'balanced', false)).toBe(totalWorkers(12, 'balanced'));
    expect(adaptiveWorkers(12, 0, 'balanced', true)).toBe(totalWorkers(12, 'balanced'));
    expect(adaptiveWorkers(12, 11, 'full', true)).toBe(totalWorkers(12, 'full'));
  });

  it('slots: strict keeps the level\'s batches; adaptive allows up to Full\'s workers (each process is gated)', () => {
    expect(maxBatchSlots(12, 'balanced', true)).toBe(parallelBatches(12, 'balanced'));
    expect(maxBatchSlots(12, 'balanced', false)).toBeGreaterThanOrEqual(parallelBatches(12, 'balanced'));
    expect(maxBatchSlots(12, 'light', true)).toBe(1);
  });

  it('measures the machine: no answer from one sample, a number of cores from two a second apart', async () => {
    machineBusyCores(os.cpus().length);
    await new Promise((r) => setTimeout(r, 1100));
    const busy = machineBusyCores(os.cpus().length);
    expect(busy).toBeGreaterThanOrEqual(0);
    if (process.platform !== 'win32') { expect(physicalCores()).toBeGreaterThan(0); }
    expect(busy).toBeLessThanOrEqual(os.cpus().length);
    setSpeedStrict(true);
    expect(workersNow(0, 12)).toBe(totalWorkers(12, 'balanced'));
  });
});

describe('memory for another test process', () => {
  const GB = 1024 ** 3;
  it('leaves the reserve free once the new process is counted', () => {
    expect(memoryLow(5 * GB, 16 * GB, 0)).toBe(false);
    expect(memoryLow(5 * GB, 16 * GB, 2 * GB)).toBe(false);   // 3 GB left ≥ 2 GB
    expect(memoryLow(5 * GB, 16 * GB, 3.5 * GB)).toBe(true);  // 1.5 GB left
  });
});

describe('what our own test processes use', () => {
  it('reads ps CPU times', () => {
    expect(psSeconds('0:01.50')).toBeCloseTo(1.5);
    expect(psSeconds('12:03.00')).toBe(723);
    expect(psSeconds('1:02:03')).toBe(3723);
    expect(psSeconds('2-01:00:00')).toBe(176400);
  });

  (process.platform === 'win32' ? it.skip : it)('counts a busy child process as ours, not as another program', async () => {
    machineLoad(os.cpus().length);
    const child = spawn(process.execPath, ['-e', 'const end = Date.now() + 1800; while (Date.now() < end) {}']);
    await new Promise((r) => setTimeout(r, 1500));
    const load = machineLoad(os.cpus().length);
    child.kill();
    expect(load).toBeDefined();
    expect(load!.ours).toBeGreaterThan(0.5);
    expect(largestTestProcessMemory()).toBeGreaterThan(1024 * 1024);
  });
});

