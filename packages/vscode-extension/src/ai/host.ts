/**
 * What the AI tool handlers need from the extension: the projects with
 * their stores, and the few actions an assistant may take — each the same
 * code path as the user's own button. extension.ts implements it over the
 * ProjectRegistry (AiBridge.ts); unit tests implement it with real stores.
 *
 * No VS Code import, so the handlers are unit-tested directly.
 */
import type { ResultStore } from '../store/ResultStore';
import type { CoverageStore } from '../coverage/CoverageStore';
import type { ExecutionTraceStore } from '../store/ExecutionTraceStore';

/** One framework of a project, as the answers describe it. */
export interface BridgeFramework {
  /** `jest`, `vitest`, `angular`, `pytest` (`cra` reports as jest). */
  id: string;
  /** "Jest" */
  displayName: string;
  /** Why coverage is not measured, else undefined. */
  coverageOff?: string;
  /** Why the per-test trace is off, else undefined (also when the framework has none). */
  traceOff?: string;
}

export interface BridgeProject {
  id: string;
  name: string;
  root: string;
  /** "jest", "jest + vitest" … */
  frameworkLabel: string;
  store: ResultStore;
  coverageStore: CoverageStore;
  traceStore: ExecutionTraceStore;
  sessionActive(): boolean;
  running(): boolean;
  discovering(): boolean;
  progress(): { completed: number; total: number; failed: number };
  /** When the project's latest runs started (0: never). */
  runsStartedAt(): number;
  /** The frameworks the project uses (the main one first). */
  frameworks(): BridgeFramework[];
  /** The framework that runs a test file (or a source file's main one). */
  frameworkOf(filePath: string): BridgeFramework;
  /** Mixed projects: test file → framework id. */
  placements(): Record<string, string> | undefined;

  // ── Actions (the user's own code paths) ──
  /** ▶ Run on one test / suite / file. */
  runScope(args: { scope: 'test' | 'suite' | 'file'; fileId: string; nodeId?: string; fullName?: string }): Promise<void>;
  /** ▶ Run on whole test files (none = nothing). */
  runFiles(fileIds: string[], label: string, cancelled: () => boolean): Promise<string[]>;
  /** What a save of these files would rerun, now. */
  runChangedFiles(filePaths: string[], label: string): Promise<string[]>;
}

export type AllowRuns = 'always' | 'ask' | 'never';

export interface BridgeHost {
  projects(): BridgeProject[];
  /** The project the panels show. */
  selected(): BridgeProject | undefined;
  /** Workspace folders (absolute). */
  folders(): string[];
  editorName: string;
  extensionVersion: string;
  /** The saved text of a file (failure line numbers are those of the run). */
  readText(file: string): string | undefined;
  allowRuns(): AllowRuns;
  /** `ask`: a modal per run; resolves to the user's answer. */
  confirmRun(what: string): Promise<boolean>;
  /** Visible notice that an assistant started a run (status bar + log line). */
  announceRun(what: string): void;
  /** The existing Clear Cache and Restart Testing (only while the session is on). */
  clearCacheAndRestart(project: BridgeProject): void;
  /** The existing Update snapshot dialog. @returns true when the user said yes and it ran. */
  updateSnapshot(project: BridgeProject, fileId: string, nodeId: string): Promise<boolean>;
  /** Focus a result in the Results panel. */
  showResult(project: BridgeProject, fileId: string, nodeId: string): void;
  /** Open a file at a line (1-based) with coverage shown. */
  showFile(filePath: string, line: number): Promise<void>;
  /** The Copy diagnostic report text. */
  diagnostics(): string;
}
