import { FrameworkId } from '../types';
import { FrameworkAdapter } from './adapters/FrameworkAdapter';
import { CRAAdapter } from './adapters/CRAAdapter';
import { JestAdapter } from './adapters/JestAdapter';
import { VitestAdapter } from './adapters/VitestAdapter';
import { PytestAdapter } from './adapters/PytestAdapter';

/** Priorities of the shipped adapters — higher is checked first. */
export const ADAPTER_PRIORITIES = {
  /** Must precede Jest — CRA projects also have jest in their deps. */
  cra: 300,
  /** Vitest only when nothing marks the project as Jest (BUG-37). */
  vitest: 200,
  /** Plain Jest (and Next.js + Jest, etc.). */
  jest: 100,
  /** pytest (Python) — only folders no JS framework claims (a JS + Python root is a later release). */
  pytest: 50,
} as const;

interface Entry { adapter: FrameworkAdapter; priority: number; seq: number }

/**
 * FrameworkRegistry — the framework adapters the detector chooses from.
 *
 * Adding a framework = `registry.register(new YourAdapter(), priority)`.
 * Adapters are tried highest priority first; equal priorities in
 * registration order. Ids are open strings (FrameworkId), so registering
 * needs no edit to a shared union. Registering an id again replaces it.
 */
export class FrameworkRegistry {
  private readonly entries: Entry[] = [];
  private seq = 0;

  register(adapter: FrameworkAdapter, priority: number): this {
    this.unregister(adapter.framework);
    this.entries.push({ adapter, priority, seq: this.seq++ });
    this.entries.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return this;
  }

  unregister(framework: FrameworkId): boolean {
    const i = this.entries.findIndex((e) => e.adapter.framework === framework);
    if (i < 0) { return false; }
    this.entries.splice(i, 1);
    return true;
  }

  get(framework: FrameworkId): FrameworkAdapter | undefined {
    return this.entries.find((e) => e.adapter.framework === framework)?.adapter;
  }

  /** Adapters in the order the detector tries them. */
  adapters(): FrameworkAdapter[] {
    return this.entries.map((e) => e.adapter);
  }

  private static _default?: FrameworkRegistry;

  /**
   * The shipped adapters. Built on first use, not at module load: adapters
   * import their runners, which import the detector and this registry — an
   * eager instance would meet a half-loaded module.
   */
  static default(): FrameworkRegistry {
    return FrameworkRegistry._default ??= new FrameworkRegistry()
      .register(new CRAAdapter(), ADAPTER_PRIORITIES.cra)
      .register(new VitestAdapter(), ADAPTER_PRIORITIES.vitest)
      .register(new JestAdapter(), ADAPTER_PRIORITIES.jest)
      .register(new PytestAdapter(), ADAPTER_PRIORITIES.pytest);
  }
}
