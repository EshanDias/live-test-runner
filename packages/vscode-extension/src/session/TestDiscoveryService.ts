import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ResultStore, makeNodeId } from '../store/ResultStore';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { discoverTests } = require('./instrumentation/testDiscovery.js') as {
  discoverTests: (
    source: string,
    filePath: string,
    rootDir: string,
  ) => {
    suites: Array<{
      name: string;
      line: number;
      tests: Array<{ name: string; line: number; fullName: string }>;
      children: Array<any>;
      isSharedVars: boolean;
      sharedVarNames: string[];
    }>;
    rootTests: Array<{ name: string; line: number; fullName: string }>;
  } | null;
};

export interface DiscoveryCallbacks {
  /** Called once the file list is known, before any AST parsing starts. */
  onFilesFound(total: number): void;
  /** Called after each file is parsed — carries the serialised FileResult for the webview. */
  onFileDiscovered(file: unknown, discovered: number, total: number): void;
  /** Called when all files have been parsed (or 0 files were found). */
  onComplete(): void;
}

// Number of files to parse per event-loop batch. Keeps the host responsive
// between batches while still processing multiple files per tick.
const BATCH_SIZE = 8;

/** Yields to the event loop so VS Code can process messages between batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * TestDiscoveryService — statically discovers test structure from source files.
 *
 * Lifecycle:
 *  1. `start()` — called on extension activate with `DiscoveryCallbacks`.
 *     Finds all test files, then parses their ASTs in batches.
 *     After each batch, yields to the event loop and fires `onFileDiscovered`
 *     so the UI renders incrementally.
 *     When done, sets up a FileSystemWatcher for subsequent changes.
 *
 *  2. `awaitDiscovery()` — awaited by SessionManager before a run starts.
 *     Resolves immediately if discovery is already finished.
 *
 *  3. FileSystemWatcher — re-discovers individual files on change/create
 *     (only while no session is active, so live results are never clobbered).
 */
export class TestDiscoveryService {
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _discoveryPromise: Promise<void> = Promise.resolve();
  private _isDiscovering = false;

  get isDiscovering(): boolean {
    return this._isDiscovering;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Kicks off background discovery. Safe to call multiple times — a new call
   * cancels any pending watch and restarts from scratch (e.g. project root changed).
   */
  start(
    projectRoot: string,
    store: ResultStore,
    log: (msg: string) => void,
    callbacks: DiscoveryCallbacks,
  ): void {
    this._watcher?.dispose();
    this._isDiscovering = true;

    this._discoveryPromise = this._run(projectRoot, store, log, callbacks)
      .catch((err) => {
        log(`[TestDiscovery] Error during discovery: ${err}`);
      })
      .finally(() => {
        this._isDiscovering = false;
        callbacks.onComplete();
        this._setupWatcher(projectRoot, store, log, callbacks);
      });
  }

  /**
   * Returns a promise that resolves when the current discovery pass is complete.
   * Used by SessionManager to gate "Start Testing" until the store is populated.
   */
  awaitDiscovery(): Promise<void> {
    return this._discoveryPromise;
  }

  dispose(): void {
    this._watcher?.dispose();
    this._watcher = undefined;
  }

  // ── Private: discovery run ─────────────────────────────────────────────────

  private async _run(
    projectRoot: string,
    store: ResultStore,
    log: (msg: string) => void,
    callbacks: DiscoveryCallbacks,
  ): Promise<void> {
    // ── Step 1: find all test files (fast — native VS Code glob) ─────────────
    const pattern = new vscode.RelativePattern(
      projectRoot,
      '**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}',
    );
    const uris  = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
    const paths = uris.map((u) => u.fsPath).sort();

    log(`[TestDiscovery] Found ${paths.length} test file(s)`);
    callbacks.onFilesFound(paths.length);

    if (paths.length === 0) { return; }

    // ── Step 2: parse ASTs in batches, yielding between each batch ───────────
    let discovered = 0;

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      // Yield before each batch so the extension host can process messages and
      // keep the UI responsive even on large projects.
      await yieldToEventLoop();

      const batch = paths.slice(i, i + BATCH_SIZE);
      for (const filePath of batch) {
        const fileData = this._populateFile(filePath, projectRoot, store, log);
        discovered++;
        if (fileData) {
          callbacks.onFileDiscovered(fileData, discovered, paths.length);
        }
      }
    }
  }

  // ── Private: file watcher ──────────────────────────────────────────────────

  private _setupWatcher(
    projectRoot: string,
    store: ResultStore,
    log: (msg: string) => void,
    callbacks: DiscoveryCallbacks,
  ): void {
    const pattern = new vscode.RelativePattern(
      projectRoot,
      '**/*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs}',
    );
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (uri: vscode.Uri) => {
      const existing = store.getFile(uri.fsPath);
      // Only skip if the file is mid-run — don't interfere with in-progress results.
      // For any other status (pending, passed, failed, skipped) drop and re-populate
      // so new/renamed/deleted tests appear in the tree immediately.
      if (existing?.status === 'running') { return; }
      if (existing) { store.removeFile(uri.fsPath); }

      log(`[TestDiscovery] Re-discovering: ${uri.fsPath}`);
      const fileData = this._populateFile(uri.fsPath, projectRoot, store, log);
      if (fileData) {
        callbacks.onFileDiscovered(fileData, 1, 1);
      }
    };

    this._watcher.onDidChange(handleChange);
    this._watcher.onDidCreate(handleChange);
    // Deleted files: leave stale data in place — it disappears on the next run.
  }

  // ── Private: per-file AST parse + store populate ──────────────────────────

  /**
   * Reads, parses, and populates one file. Returns the serialised FileResult
   * (ready to postMessage to a webview) or null if parsing failed.
   */
  private _populateFile(
    filePath: string,
    projectRoot: string,
    store: ResultStore,
    log: (msg: string) => void,
  ): unknown | null {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    const result = discoverTests(source, filePath, projectRoot);
    if (!result) {
      log(`[TestDiscovery] AST parse failed: ${filePath}`);
      return null;
    }

    const relativeName = path.relative(projectRoot, filePath);
    store.fileDiscovered(filePath, filePath, relativeName);

    // Rebuild the line map from fresh AST data on every pass so edits are
    // reflected immediately (the watcher calls this on every save).
    store.clearLineMap(filePath);

    // Root-level tests (no enclosing describe) → '(root)' suite node,
    // matching the convention used by JestAdapter._applyFileResult.
    if (result.rootTests.length > 0) {
      const rootSuiteId = makeNodeId(filePath, [], '(root)');
      store.nodeDiscovered(filePath, rootSuiteId, null, 'suite', '(root)', '(root)');
      for (const t of result.rootTests) {
        const isDynamic = t.name.match(/…|%[isdjpxofc]/);
        const testId = makeNodeId(filePath, ['(root)'], t.fullName);
        store.nodeDiscovered(
          filePath,
          testId,
          rootSuiteId,
          isDynamic ? 'suite' : 'test',
          t.name,
          t.fullName,
          t.line,
          !!isDynamic
        );
        if (t.line) {
          store.setLineEntry(filePath, t.line, { nodeId: testId, fileId: filePath });
        }
      }
    }

    // Named suites — walk the recursive tree
    this._populateSuiteTree(filePath, result.suites, [], null, store);

    // Return the serialised file for the webview
    return store.serialiseFile(filePath);
  }

  /**
   * Recursively populate the store with suite nodes and their children.
   */
  private _populateSuiteTree(
    filePath: string,
    suites: Array<{
      name: string;
      line: number;
      tests: Array<{ name: string; line: number; fullName: string }>;
      children: Array<any>;
      isSharedVars: boolean;
      sharedVarNames: string[];
    }>,
    ancestorNames: string[],
    parentId: string | null,
    store: ResultStore,
  ): void {
    for (const suite of suites) {
      const isDynamic = suite.name.match(/…|%[isdjpxofc]/);
      const suiteId = makeNodeId(filePath, ancestorNames, suite.name);
      store.nodeDiscovered(
        filePath,
        suiteId,
        parentId,
        'suite',
        suite.name,
        [...ancestorNames, suite.name].join(' '),
        suite.line,
        !!isDynamic
      );
      if (suite.line) {
        store.setLineEntry(filePath, suite.line, { nodeId: suiteId, fileId: filePath });
      }

      // Populate direct test children
      const testAncestors = [...ancestorNames, suite.name];
      for (const t of suite.tests) {
        const isDynamic = t.name.match(/…|%[isdjpxofc]/);
        const testId = makeNodeId(filePath, testAncestors, t.name);
        store.nodeDiscovered(
          filePath,
          testId,
          suiteId,
          isDynamic ? 'suite' : 'test',
          t.name,
          t.fullName,
          t.line,
          !!isDynamic
        );
        if (t.line) {
          store.setLineEntry(filePath, t.line, { nodeId: testId, fileId: filePath });
        }
      }

      // Recurse into child suites
      if (suite.children && suite.children.length > 0) {
        this._populateSuiteTree(filePath, suite.children, testAncestors, suiteId, store);
      }
    }
  }
}
