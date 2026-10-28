import type { ResultStore } from '../store/ResultStore';
import type { CoverageStore } from '../coverage/CoverageStore';
import type { ExecutionTraceStore } from '../store/ExecutionTraceStore';

/** The stores of the project a file belongs to (a ProjectContext satisfies it). */
export interface FileStores {
  readonly store: ResultStore;
  readonly coverageStore: CoverageStore;
  readonly traceStore: ExecutionTraceStore;
}

/**
 * The stores for a file — the file's own project, whichever project the
 * Explorer shows (phase 7, owner decision 2026-10-22). Undefined: the file
 * belongs to no test project.
 */
export type FileStoresResolver = (filePath: string) => FileStores | undefined;
