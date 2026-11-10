import { parallelBatches, workerCount, workersPerBatch } from '../src/utils/resources';
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
