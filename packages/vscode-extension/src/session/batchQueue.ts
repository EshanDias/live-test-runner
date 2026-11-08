import { runnableKey } from './RunnableFiles';

/** One batch of a run: files of one framework, run by one process. */
export interface QueuedBatch<S> { batch: string[]; services: S }

/**
 * The run's batch queue: each framework's files cut into batches of its size.
 * Files in `first` (the test files on screen) come first, in batches of their
 * own — a framework orders a batch's files itself, so only their own batch
 * makes their results show while the rest runs.
 */
export function buildBatchQueue<S>(
  byFramework: Map<S, string[]>,
  sizeOf: (services: S) => number,
  first: ReadonlySet<string> = new Set(),
): QueuedBatch<S>[] {
  const front: QueuedBatch<S>[] = [];
  const back: QueuedBatch<S>[] = [];
  const cut = (files: string[], services: S, into: QueuedBatch<S>[]) => {
    const size = Math.max(1, sizeOf(services));
    for (let i = 0; i < files.length; i += size) { into.push({ batch: files.slice(i, i + size), services }); }
  };
  for (const [services, files] of byFramework) {
    const shown = first.size > 0 ? files.filter((f) => first.has(runnableKey(f))) : [];
    cut(shown, services, front);
    cut(shown.length > 0 ? files.filter((f) => !first.has(runnableKey(f))) : files, services, back);
  }
  return [...front, ...back];
}

/**
 * Moves a file still waiting in the queue to a batch of its own at the front.
 * @returns false when it is not waiting (already running or done, not in the
 *          run, or alone in its batch already)
 */
export function promoteInQueue<S>(queue: QueuedBatch<S>[], filePath: string): boolean {
  const key = runnableKey(filePath);
  const at = queue.findIndex((q) => q.batch.some((f) => runnableKey(f) === key));
  if (at < 0) { return false; }
  const q = queue[at];
  if (q.batch.length === 1) {
    if (at === 0) { return false; }
    queue.splice(at, 1);
    queue.unshift(q);
    return true;
  }
  const fp = q.batch.find((f) => runnableKey(f) === key)!;
  q.batch = q.batch.filter((f) => f !== fp);
  queue.unshift({ batch: [fp], services: q.services });
  return true;
}
