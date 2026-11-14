/**
 * Runs an AI assistant started (LTR_run_tests, LTR_run_failed,
 * LTR_verify_fix). One at a time — a second waits for the first — so an
 * agent cannot pile up work; every run goes through the session's own run
 * methods and so shares the machine budget (rule 10). A run remembers each
 * test's status from before it started, so its answer can say what it fixed
 * and what it broke.
 */
import type { TestStatus } from '../store/ResultStore';
import type { BridgeProject } from './host';

export type AgentRunState = 'queued' | 'running' | 'finished' | 'cancelled';

/** Test statuses by project id → node id. */
export type StatusSnapshot = Map<string, Map<string, TestStatus>>;

export interface AgentRun {
  id: string;
  /** What it runs, for the log and the answer ("2 tests", "files affected by src/a.ts"). */
  label: string;
  state: AgentRunState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Statuses before the run (what "fixed" / "newly failing" compare against). */
  baseline: StatusSnapshot;
  /** What the counts cover: whole test files, or nodes (a test or suite) in them. */
  scope: Array<{ project: BridgeProject; fileId: string; nodeId?: string }>;
  /** Test files that reported results while the run was in flight (verify runs count these). */
  touched: Set<string>;
  cancelled: boolean;
  error?: string;
  done: Promise<void>;
}

const KEEP_RUNS = 30;

export function snapshotStatuses(projects: BridgeProject[]): StatusSnapshot {
  const snap: StatusSnapshot = new Map();
  for (const p of projects) {
    const m = new Map<string, TestStatus>();
    for (const f of p.store.getAllFiles()) {
      for (const n of p.store.getFileNodes(f.fileId)) {
        if (n.type === 'test') { m.set(n.id, n.status); }
      }
    }
    snap.set(p.id, m);
  }
  return snap;
}

export class AgentRuns {
  private readonly _runs = new Map<string, AgentRun>();
  private _chain: Promise<void> = Promise.resolve();
  private _seq = 0;

  /**
   * Queues a run. `work` does it (through the session); it should check
   * `run.cancelled` between steps.
   */
  start(
    label: string,
    baseline: StatusSnapshot,
    scope: AgentRun['scope'],
    work: (run: AgentRun) => Promise<void>,
  ): AgentRun {
    const run: AgentRun = {
      id: `run-${++this._seq}`,
      label,
      state: 'queued',
      queuedAt: Date.now(),
      baseline,
      scope,
      touched: new Set(),
      cancelled: false,
      done: Promise.resolve(),
    };
    run.done = this._chain = this._chain.then(async () => {
      if (run.cancelled) { run.state = 'cancelled'; run.finishedAt = Date.now(); return; }
      run.state = 'running';
      run.startedAt = Date.now();
      try {
        await work(run);
      } catch (err) {
        run.error = (err as Error).message;
      } finally {
        run.state = run.cancelled ? 'cancelled' : 'finished';
        run.finishedAt = Date.now();
      }
    });
    this._runs.set(run.id, run);
    this._prune();
    return run;
  }

  get(id: string): AgentRun | undefined {
    return this._runs.get(id);
  }

  /** The run in flight, if any. */
  active(): AgentRun | undefined {
    for (const r of this._runs.values()) { if (r.state === 'running') { return r; } }
    return undefined;
  }

  latest(): AgentRun | undefined {
    return [...this._runs.values()].pop();
  }

  /** @returns false when there is no such run or it already ended. */
  cancel(id: string): boolean {
    const run = this._runs.get(id);
    if (!run || run.state === 'finished' || run.state === 'cancelled') { return false; }
    run.cancelled = true;
    return true;
  }

  /** The user pressed Stop: nothing an assistant queued goes on. */
  cancelAll(): void {
    for (const r of this._runs.values()) { if (r.state === 'queued' || r.state === 'running') { r.cancelled = true; } }
  }

  /** A test file reported results (observer): counts toward the run in flight. */
  noteFileResult(fileId: string): void {
    const run = this.active();
    if (run) { run.touched.add(fileId); }
  }

  /** Waits until the run ends or `ms` pass. */
  async wait(run: AgentRun, ms: number): Promise<void> {
    if (ms <= 0) { return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run.done, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
  }

  private _prune(): void {
    if (this._runs.size <= KEEP_RUNS) { return; }
    for (const [id, r] of this._runs) {
      if (this._runs.size <= KEEP_RUNS) { break; }
      if (r.state === 'finished' || r.state === 'cancelled') { this._runs.delete(id); }
    }
  }
}
