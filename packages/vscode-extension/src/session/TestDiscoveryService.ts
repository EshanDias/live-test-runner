import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ResultStore, makeNodeId } from '../store/ResultStore';
import { DiscoveryCache } from '../cache/DiscoveryCache';
import { logger } from '../utils/logger';

const FILE = 'TestDiscoveryService.ts';

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
  /** Called once per batch with all files parsed in that batch. */
  onBatchDiscovered(files: unknown[], discovered: number, total: number): void;
  /** Called when all files have been parsed (or 0 files were found). */
  onComplete(): void;
  /** Called when a watched test file is deleted (e.g. temp files from e2e tests). */
  onFileRemoved?(fileId: string): void;
}

// Batch sizes for discovery passes.
// Cold (no cache): small batches keep UI responsive during slow Babel parse.
// Warm (cache hits): larger batches since stat+store is ~10x faster than parse.
const BATCH_SIZE_COLD = 5;
const BATCH_SIZE_WARM = 25;

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
  private _store: ResultStore | undefined;
  private _log: ((msg: string) => void) | undefined;
  private _callbacks: DiscoveryCallbacks | undefined;
  private _cache: DiscoveryCache | undefined;

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
    cache?: DiscoveryCache,
  ): void {
    this._watcher?.dispose();
    this._isDiscovering = true;
    this._store = store;
    this._log = log;
    this._callbacks = callbacks;
    this._cache = cache;

    this._discoveryPromise = this._run(projectRoot, store, log, callbacks, cache)
      .catch((err) => {
        log(`[TestDiscovery] Error during discovery: ${err}`);
        logger.error(FILE, 'start', `Discovery run failed for root="${projectRoot}"`, err);
      })
      .finally(() => {
        this._isDiscovering = false;
        cache?.flush();
        callbacks.onComplete();
        this._setupWatcher(projectRoot, store, log, callbacks);
      });
  }

  /**
   * Scans every file currently in the store and removes any whose path no
   * longer exists on disk.  Call this after a test run or trace completes to
   * evict ghost entries left behind when an e2e test deletes a whole directory
   * (e.g. via rimraf) — VS Code's file-system watcher only sees the directory
   * deletion, not the individual file deletions inside it.
   */
  pruneGhostFiles(): void {
    const store = this._store;
    const callbacks = this._callbacks;
    const log = this._log;
    if (!store || !callbacks) { return; }
    for (const file of store.getAllFiles()) {
      if (!fs.existsSync(file.filePath)) {
        log?.(`[TestDiscovery] Pruning ghost file: ${file.filePath}`);
        logger.debug(FILE, 'pruneGhostFiles', `Removing ghost: "${file.filePath}"`);
        store.removeFile(file.fileId);
        callbacks.onFileRemoved?.(file.fileId);
      }
    }
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
    cache?: DiscoveryCache,
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
    // Use larger batches when a cache is present — stat+store is ~10x faster
    // than a cold Babel parse, so we can process more files per tick without
    // blocking the UI noticeably.
    const batchSize = cache ? BATCH_SIZE_WARM : BATCH_SIZE_COLD;
    let discovered = 0;

    for (let i = 0; i < paths.length; i += batchSize) {
      // Yield before each batch so the extension host can process messages and
      // keep the UI responsive even on large projects.
      await yieldToEventLoop();

      const batch = paths.slice(i, i + batchSize);
      const batchFiles: unknown[] = [];
      for (const filePath of batch) {
        const fileData = this._populateFile(filePath, projectRoot, store, log, cache);
        discovered++;
        if (fileData) {
          batchFiles.push(fileData);
        }
      }
      if (batchFiles.length > 0) {
        callbacks.onBatchDiscovered(batchFiles, discovered, paths.length);
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
      if (existing?.status === 'running') { return; }

      // Guard against create-then-delete races: VS Code may fire onDidCreate for
      // a file that is already gone by the time we process the event (e.g. a
      // temporary test file written and deleted by an e2e test).  If the file no
      // longer exists, treat it as a deletion so it doesn't remain as a ghost.
      if (!fs.existsSync(uri.fsPath)) {
        if (existing) {
          log(`[TestDiscovery] File gone before processing, removing: ${uri.fsPath}`);
          store.removeFile(uri.fsPath);
          callbacks.onFileRemoved?.(uri.fsPath);
        }
        return;
      }

      // Clear the line map before re-discovery so that decorations are
      // correctly repositioned (orphans cleared, moves updated).
      store.clearLineMap(uri.fsPath);

      log(`[TestDiscovery] Re-discovering: ${uri.fsPath}`);
      const fileData = this._populateFile(uri.fsPath, projectRoot, store, log, this._cache);
      if (fileData) {
        callbacks.onBatchDiscovered([fileData], 1, 1);
        this._cache?.flush();
      }
    };

    this._watcher.onDidChange(handleChange);
    this._watcher.onDidCreate(handleChange);
    this._watcher.onDidDelete((uri) => {
      store.removeFile(uri.fsPath);
      callbacks.onFileRemoved?.(uri.fsPath);
    });
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
    cache?: DiscoveryCache,
  ): unknown | null {
    // ── Try cache first (skip readFile + Babel if mtime unchanged) ────────────
    let result: ReturnType<typeof discoverTests> | null = null;

    if (cache) {
      result = cache.get(filePath) ?? null;
      if (result) {
        log(`[TestDiscovery] Cache hit: ${filePath}`);
      }
    }

    if (!result) {
      let source: string;
      try {
        source = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        logger.error(FILE, '_populateFile', `Could not read test file: "${filePath}"`, err);
        return null;
      }

      try {
        result = discoverTests(source, filePath, projectRoot);
      } catch (err) {
        logger.error(FILE, '_populateFile', `discoverTests threw for "${filePath}"`, err);
        log(`[TestDiscovery] AST parse error: ${filePath}`);
        return null;
      }

      if (!result) {
        logger.warn(FILE, '_populateFile', `AST parse returned null for "${filePath}"`);
        log(`[TestDiscovery] AST parse failed: ${filePath}`);
        return null;
      }

      // Write to cache only for files that have actual Jest tests
      if (cache && (result.suites.length > 0 || result.rootTests.length > 0)) {
        try {
          const { mtimeMs } = fs.statSync(filePath);
          cache.set(filePath, mtimeMs, result);
        } catch { /* stat failed — skip caching this file */ }
      }
    }

    // If no tests were found (e.g. all describe/test calls are imported from a
    // non-Jest package like tstyche), skip this file entirely so it doesn't
    // appear as an empty entry in the test list.
    if (result.suites.length === 0 && result.rootTests.length === 0) {
      log(`[TestDiscovery] No Jest tests found, skipping: ${filePath}`);
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
