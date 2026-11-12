import * as os from 'os';
import { spawn } from 'child_process';
import { availableMemory, lowerPriority, memoryLow, parallelBatches, workerCount, workersPerBatch } from '../src/utils/resources';
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
