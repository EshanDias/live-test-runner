import { batchSize, buildBatchQueue, promoteInQueue } from '../src/session/batchQueue';

const files = (n: number, dir = '/p') => Array.from({ length: n }, (_, i) => `${dir}/t${i + 1}.test.js`);
const batches = (q: { batch: string[]; services: string }[]) => q.map((b) => `${b.services}:${b.batch.map((f) => f.replace(/^.*\//, '')).join(',')}`);

describe('buildBatchQueue', () => {
  it('cuts each framework into batches of its size', () => {
    const q = buildBatchQueue(new Map([['jest', files(5)], ['pytest', ['/p/test_a.py', '/p/test_b.py']]]), (s) => (s === 'jest' ? 2 : 300));
    expect(batches(q)).toEqual(['jest:t1.test.js,t2.test.js', 'jest:t3.test.js,t4.test.js', 'jest:t5.test.js', 'pytest:test_a.py,test_b.py']);
  });

  it('the files on screen come first, in batches of their own, for every framework', () => {
    const q = buildBatchQueue(new Map([['jest', files(5)], ['pytest', ['/p/test_a.py', '/p/test_b.py']]]), (s) => (s === 'jest' ? 3 : 300),
      new Set(['/p/t4.test.js', '/p/test_b.py']));
    expect(batches(q)).toEqual(['jest:t4.test.js', 'pytest:test_b.py', 'jest:t1.test.js,t2.test.js,t3.test.js', 'jest:t5.test.js', 'pytest:test_a.py']);
  });

  it('a file on screen that is not in the run changes nothing', () => {
    const q = buildBatchQueue(new Map([['jest', files(3)]]), () => 2, new Set(['/p/other.test.js']));
    expect(batches(q)).toEqual(['jest:t1.test.js,t2.test.js', 'jest:t3.test.js']);
  });
});

describe('promoteInQueue', () => {
  it('moves a waiting file out of its batch to the front', () => {
    const q = buildBatchQueue(new Map([['jest', files(6)]]), () => 3);
    expect(promoteInQueue(q, '/p/t5.test.js')).toBe(true);
    expect(batches(q)).toEqual(['jest:t5.test.js', 'jest:t1.test.js,t2.test.js,t3.test.js', 'jest:t4.test.js,t6.test.js']);
  });

  it('a batch of one moves to the front as it is; already first or not waiting: nothing to do', () => {
    const q = buildBatchQueue(new Map([['jest', files(3)]]), () => 2);
    expect(promoteInQueue(q, '/p/t3.test.js')).toBe(true);
    expect(batches(q)).toEqual(['jest:t3.test.js', 'jest:t1.test.js,t2.test.js']);
    expect(promoteInQueue(q, '/p/t3.test.js')).toBe(false);
    expect(promoteInQueue(q, '/p/gone.test.js')).toBe(false);
  });
});

describe('batchSize', () => {
  const batches = (total: number, parallel: number) => Math.ceil(total / batchSize(total, parallel));

  it('small runs: one batch per parallel slot, never below the minimum', () => {
    expect(batchSize(9, 3)).toBe(5);
    expect(batchSize(100, 3)).toBe(34);
    expect(batchSize(3, 1)).toBe(5);
  });

  it('never above the maximum', () => {
    for (const total of [151, 999, 2500, 10_000]) { expect(batchSize(total, 3)).toBeLessThanOrEqual(50); }
  });

  it('fills whole rounds: 500 files, 3 at a time → 12 batches, not 10 (a last round of one)', () => {
    expect(batches(500, 3)).toBe(12);
    expect(batches(500, 3) % 3).toBe(0);
    expect(batches(1200, 4) % 4).toBe(0);
  });

  it('one batch at a time (budget 1): plain chunks of the maximum', () => {
    expect(batchSize(500, 1)).toBe(50);
    expect(batchSize(0, 3)).toBe(5);
  });
});
